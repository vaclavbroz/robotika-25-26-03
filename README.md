# HRA Local Development

## Requirements

- Git
- Node.js 18 or newer
- npm, included with Node.js

Check your versions:

```bash
git --version
node --version
npm --version
```

## Local Setup From GitHub

Clone your team repository:

```bash
git clone <your-team-repo-url>
cd <your-team-repo-folder>
```

Install dependencies:

```bash
npm install
```

The root install automatically installs the client dependencies under `packages/client`.

Start the game:

```bash
npm run dev
```

Then open the URL printed in the terminal. In a standalone home clone, the default is:

```text
http://localhost:8000/
```

You can also start with:

```bash
./start.sh
```

This starts:

- client (`packages/client`)
- server (`packages/server`)

You should see prefixed logs in the same terminal:

- `[client]` Vite startup and URL
- `[server]` websocket/tick logs

## Dev Ports Configuration

In the classroom workspace, ports are derived from the team folder name:

- `team1`: app/client `8001`, websocket `9001`
- `team12`: app/client `8012`, websocket `9012`

In a standalone home clone, defaults are:

- app/client: `8000`
- websocket server: `9001`

Override either port when needed:

```bash
APP_PORT=8010 WS_PORT=9010 npm run dev
```

Use different ports if `8000` or `9001` is already busy on your computer.

## Verify Server Connect/Disconnect Logs

Open the client URL shown in `[client]` logs to trigger a WebSocket connect.

You can also use this temporary smoke client in another terminal while stack is running:

```bash
node -e 'const ws=new WebSocket("ws://127.0.0.1:9001");ws.onmessage=(e)=>{console.log(e.data);setTimeout(()=>ws.close(),1000);};'
```

Expected server logs:

- `connected playerId=...`
- `disconnected playerId=...`
