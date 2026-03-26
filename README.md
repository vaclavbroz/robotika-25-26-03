# HRA Local Development

## Start The Full Stack (Console)

Use the root helper script:

```bash
./start.sh
```

This runs `npm run dev` and starts:

- client (`packages/client`)
- server (`packages/server`)

You should see prefixed logs in the same terminal:

- `[client]` Vite startup and URL (default `http://localhost:8003/`)
- `[server]` websocket/tick logs

## Dev Ports Configuration

Ports are derived from the team folder name.

Defaults:

- app/client: `8003`
- websocket server: `9003`

## Verify Server Connect/Disconnect Logs

Open the client URL shown in `[client]` logs (default `http://localhost:8003/`) to trigger a WebSocket connect.

You can also use this temporary smoke client in another terminal while stack is running:

```bash
node -e 'const ws=new WebSocket("ws://127.0.0.1:9003");ws.onmessage=(e)=>{console.log(e.data);setTimeout(()=>ws.close(),1000);};'
```

Expected server logs:

- `connected playerId=...`
- `disconnected playerId=...`
