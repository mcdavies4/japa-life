# Japa Life realtime server

Cloudflare Worker + Durable Objects. One room per zone shard (`/room/ryelane-1`, `/room/woolwich-1`, ...).
Rooms hold up to `MAX_PER_ROOM` players; when a room is full the game automatically tries the next shard.

## Deploy
    npm install
    npx wrangler login
    npx wrangler deploy

Wrangler prints your URL, e.g. `https://japa-life-realtime.<your-subdomain>.workers.dev`.
In the game's `index.html`, set:

    const REALTIME_URL="wss://japa-life-realtime.<your-subdomain>.workers.dev";

## Allowed sites
`ALLOWED_ORIGINS` in `wrangler.toml` lists the sites allowed to connect. Add your custom domain
(e.g. `https://japalife.com`) and redeploy.

## Protocol (JSON over WebSocket)
Client -> server: `join {name, look, x, z, ry}`, `m {x, z, ry, mv}`, `chat {text}`, `ping`
Server -> client: `welcome {id, players}`, `join {p}`, `leave {id}`, `s {u: [[id,x,z,ry,mv]]}`, `chat {id, text}`, `full`

## Safety built in
Origin check, 30 messages/second limit, 1.5 s chat cooldown, 120-character messages, basic word filter.
