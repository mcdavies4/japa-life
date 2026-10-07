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
    const allowedList = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const reqOrigin = request.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": allowedList.includes(reqOrigin) ? reqOrigin : (allowedList[0] || "*"), "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const stats = () => env.STATS.get(env.STATS.idFromName("global"));
    if (url.pathname === "/e" && request.method === "POST") {
      if (allowedList.length && reqOrigin && !allowedList.includes(reqOrigin)) return new Response("no", { status: 403 });
      const body = await request.text();
      if (body.length > 2000) return new Response("too big", { status: 413 });
      await stats().fetch("https://stats/event", { method: "POST", body });
      return new Response("ok", { headers: cors });
    }
    if (url.pathname === "/stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) return new Response("Unauthorised", { status: 401, headers: cors });
      const r = await stats().fetch("https://stats/summary?days=" + (url.searchParams.get("days") || "14"));
      return new Response(await r.text(), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
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
    const m = new URL(request.url).pathname.match(/^\/room\/([a-z0-9-]{1,40})$/);
    if (m) this.roomName = m[1];
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
      this.reportPresence();
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

  reportPresence() {
    try {
      const count = [...this.sessions.values()].filter(s => s.p).length;
      if (!this.roomName) return;
      const stub = this.env.STATS.get(this.env.STATS.idFromName("global"));
      this.state.waitUntil(stub.fetch("https://stats/presence", { method: "POST", body: JSON.stringify({ room: this.roomName, count }) }).catch(() => {}));
    } catch (e) {}
  }

  tick() {
    const u = [];
    for (const s of this.sessions.values()) if (s.p && s.dirty) { u.push([s.id, s.p.x, s.p.z, s.p.ry, s.p.mv]); s.dirty = false; }
    if (u.length) this.broadcast({ t: "s", u });
  }

  leave(s) {
    if (!this.sessions.has(s.id)) return;
    this.sessions.delete(s.id);
    if (s.p) { this.broadcast({ t: "leave", id: s.id }); this.reportPresence(); }
    if (this.sessions.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}


// ---------- Stats: one global Durable Object with SQLite storage ----------
const EVENTS = new Set(["session_start","new_player","minute","chapter_done","shift","delivery","exam","card","install","travel","biz","milestone"]);
const tok = v => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9_ -]/g, "").slice(0, 32);
const today = () => new Date().toISOString().slice(0, 10);

export class StatsDO {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily (day TEXT, metric TEXT, value INTEGER, PRIMARY KEY (day, metric))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS uniq (day TEXT, uid TEXT, PRIMARY KEY (day, uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seen (uid TEXT PRIMARY KEY, first_day TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS presence (room TEXT PRIMARY KEY, count INTEGER, ts INTEGER)`);
  }
  add(day, metric, v = 1) {
    this.sql.exec(`INSERT INTO daily (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`, day, metric, v);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/presence") {
      const { room, count } = await request.json();
      this.sql.exec(`INSERT INTO presence (room, count, ts) VALUES (?, ?, ?) ON CONFLICT (room) DO UPDATE SET count = excluded.count, ts = excluded.ts`, tok(room), Math.max(0, count | 0), Date.now());
      return new Response("ok");
    }
    if (url.pathname === "/event") {
      let e; try { e = JSON.parse(await request.text()); } catch (x) { return new Response("bad", { status: 400 }); }
      if (!e || !EVENTS.has(e.name)) return new Response("ignored");
      const d = today(), uid = tok(e.uid).replace(/ /g, "");
      if (uid) {
        const before = this.sql.exec(`SELECT COUNT(*) AS n FROM uniq WHERE day = ? AND uid = ?`, d, uid).one().n;
        if (!before) { this.sql.exec(`INSERT INTO uniq (day, uid) VALUES (?, ?)`, d, uid); this.add(d, "players"); }
        const seen = this.sql.exec(`SELECT COUNT(*) AS n FROM seen WHERE uid = ?`, uid).one().n;
        if (!seen) { this.sql.exec(`INSERT INTO seen (uid, first_day) VALUES (?, ?)`, uid, d); this.add(d, "first_visit"); }
      }
      this.add(d, "ev:" + e.name);
      const p = e.props || {};
      for (const k of ["route", "home", "dream", "rel", "n", "c", "k", "kind", "how", "type", "what", "result", "returning"]) if (p[k] !== undefined) this.add(d, `${e.name}:${k}:${tok(p[k])}`);
      return new Response("ok");
    }
    if (url.pathname === "/summary") {
      const days = Math.min(60, Math.max(1, +url.searchParams.get("days") || 14));
      const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
      const rows = this.sql.exec(`SELECT day, metric, value FROM daily WHERE day >= ? ORDER BY day`, since).toArray();
      const fresh = Date.now() - 5 * 60e3;
      const rooms = this.sql.exec(`SELECT room, count FROM presence WHERE ts > ? AND count > 0 ORDER BY count DESC`, fresh).toArray();
      const total = this.sql.exec(`SELECT COUNT(*) AS n FROM seen`).one().n;
      return new Response(JSON.stringify({ generated: new Date().toISOString(), days, rows, rooms, online: rooms.reduce((a, r) => a + r.count, 0), allTimePlayers: total }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }
}
