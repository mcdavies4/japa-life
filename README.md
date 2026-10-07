# Japa Life realtime + stats server

Cloudflare Worker with two kinds of Durable Objects:
- `ZoneRoom`: one multiplayer room per street (`/room/ryelane-1`, ...).
- `StatsDO`: one global stats store (SQLite) for anonymous usage stats and who's online.

## Deploy
    npm install
    npx wrangler login
    npx wrangler secret put STATS_KEY      # choose a long password for your dashboard
    npx wrangler deploy

## Endpoints
- `GET  /health`                  -> ok
- `WS   /room/<zone>-<n>`         -> multiplayer
- `POST /e`                       -> anonymous game events (sent by the game)
- `GET  /stats?key=STATS_KEY`     -> JSON summary used by the dashboard (japa-life.pages.dev/stats.html)

## Privacy
Events carry a random anonymous id per device, the event name and a few game choices (route, area, chapter).
No names, emails, IPs or chat messages are stored. Players can turn stats off in Phone -> Settings.
