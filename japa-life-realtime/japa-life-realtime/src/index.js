// Japa Life realtime server.
// One Durable Object ("room") per zone shard, e.g. /room/ryelane-1.
// Clients send their position; the room batches updates and broadcasts ~8 times a second.

const TICK_MS = 125;
const MAX_MSG_BYTES = 1000;
const CHAT_COOLDOWN_MS = 1500;
const MAX_MSGS_PER_SEC = 30;

// Basic word filter. Extend this list as moderation needs grow.
const BLOCKED = ["fuck","shit","bitch","cunt","dick","pussy","bastard","whore","slut","nigger","nigga","faggot","retard","wanker","twat"];
const BLOCKED_RE = new RegExp("\\b(" + BLOCKED.join("|") + ")\\w*", "gi");
function clean(text) { return text.replace(BLOCKED_RE, m => m[0] + "*".repeat(Math.max(1, m.length - 1))); }

const num = (v, lo, hi) => (typeof v === "number" && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : 0;
const r2 = v => Math.round(v * 100) / 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const m = url.pathname.match(/^\/room\/([a-z0-9-]{1,40})$/);
    if (!m) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    if (allowed.length && !allowed.includes(origin)) return new Response("Origin not allowed", { status: 403 });
    const room = env.ZONE_ROOM.get(env.ZONE_ROOM.idFromName(m[1]));
    return room.fetch(request);
  }
};

export class ZoneRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.nextId = 1;
    this.timer = null;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const max = Number(this.env.MAX_PER_ROOM || 80);
    if (this.sessions.size >= max) {
      server.send(JSON.stringify({ t: "full" }));
      server.close(4001, "Room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const s = { ws: server, id: String(this.nextId++), p: null, dirty: false, lastChat: 0, count: 0, windowStart: Date.now() };
    this.sessions.set(s.id, s);
    server.addEventListener("message", e => this.onMessage(s, e.data));
    const bye = () => this.leave(s);
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(s, msg) { try { s.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)); } catch (e) { this.leave(s); } }
  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const s of this.sessions.values()) if (s.p && s !== except) this.send(s, data);
  }

  onMessage(s, raw) {
    const now = Date.now();
    if (now - s.windowStart > 1000) { s.windowStart = now; s.count = 0; }
    if (++s.count > MAX_MSGS_PER_SEC || typeof raw !== "string" || raw.length > MAX_MSG_BYTES) {
      try { s.ws.close(4008, "Too many messages"); } catch (e) {}
      return this.leave(s);
    }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "join" && !s.p) {
      const look = m.look || {};
      s.p = {
        id: s.id,
        name: String(m.name || "Someone").replace(/[<>]/g, "").trim().slice(0, 16) || "Someone",
        look: { skin: num(look.skin, 0, 3) | 0, shirt: num(look.shirt, 0, 5) | 0, hair: num(look.hair, 0, 2) | 0 },
        x: r2(num(m.x, -50, 50)), z: r2(num(m.z, -200, 200)), ry: r2(num(m.ry, -10, 10)), mv: 0
      };
      const others = [...this.sessions.values()].filter(o => o.p && o !== s).map(o => o.p);
      this.send(s, { t: "welcome", id: s.id, players: others });
      this.broadcast({ t: "join", p: s.p }, s);
      if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
      return;
    }
    if (!s.p) return;

    if (m.t === "m") {
      s.p.x = r2(num(m.x, -50, 50)); s.p.z = r2(num(m.z, -200, 200));
      s.p.ry = r2(num(m.ry, -10, 10)); s.p.mv = m.mv ? 1 : 0;
      s.dirty = true;
    } else if (m.t === "chat") {
      if (now - s.lastChat < CHAT_COOLDOWN_MS) return;
      const text = clean(String(m.text || "").replace(/[<>]/g, "").trim().slice(0, 120));
      if (!text) return;
      s.lastChat = now;
      this.broadcast({ t: "chat", id: s.id, text }, s);
    } else if (m.t === "ping") {
      this.send(s, { t: "pong" });
    }
  }

  tick() {
    const u = [];
    for (const s of this.sessions.values()) if (s.p && s.dirty) { u.push([s.id, s.p.x, s.p.z, s.p.ry, s.p.mv]); s.dirty = false; }
    if (u.length) this.broadcast({ t: "s", u });
  }

  leave(s) {
    if (!this.sessions.has(s.id)) return;
    this.sessions.delete(s.id);
    if (s.p) this.broadcast({ t: "leave", id: s.id });
    if (this.sessions.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
