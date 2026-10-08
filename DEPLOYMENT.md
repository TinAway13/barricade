# Vercel deployment

The frontend is built from `example.html` into `dist/index.html`, fixing the missing homepage in a static deployment. `vercel.json` selects the build and output directory. Set the Vercel project Root Directory to this repository directory and Framework Preset to Other. Commit/push the changes and redeploy.

## Multiplayer backend

The Go program is a persistent WebSocket server. Rooms and connected players live in one process's memory. The frontend build does not deploy this process.

Run the Go backend on a host that supports a continuously running process and WebSockets, with HTTPS enabled:

```
go build -o blockline .
./blockline
```

It reads `PORT` (default 8080). Keep a single running instance: multiple independent instances do not share rooms. Restarting it clears matches.

In Vercel Project Settings → Environment Variables, set `BLOCKLINE_WS_URL` to the backend's public WebSocket endpoint, for example `wss://your-backend.example/ws`. This is public client configuration, not a secret. Redeploy after changing it. Without it the page loads and displays that online play is not configured.

Vercel's WebSocket support does not by itself make this in-memory Go server a distributed backend. A Vercel-only backend needs an appropriate runtime entrypoint and shared storage/coordination for rooms: https://vercel.com/docs/functions/websockets#manage-persistent-state

## Local development

Run `go run .` and visit `http://localhost:8080`. The source page connects to `/ws` on the same host; no environment variable is needed locally.

## Board interaction

Click or tap a glowing tile center to move. Hover near an internal tile edge to preview a wall; its direction follows that edge automatically. Click the gap to place it. On touch screens, hold and slide on the board to preview, then release to place. Release outside the board to cancel. Placed walls cannot be moved.
