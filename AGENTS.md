# Agent Instructions

- Never run install commands on your own (for example: `npm install`, `npm i`, `pnpm install`, `yarn install`) unless the user explicitly asks for it.
- Never run build commands on your own (for example: `npm run build`, `pnpm build`, `yarn build`) unless the user explicitly asks for it.
- When creating a commit, always include newly created files that are part of the requested change (not only modified tracked files). Verify with `git status --short` before commit.

## Starting The Full Stack On Request

- If the user asks to start the full stack, use the root script:
  - `npm run dev`
- This command starts all components in parallel:
  - client (`packages/client`)
  - server (`packages/server`)
- After startup, always report:
  - client URL (typically `http://localhost:8003/`)
  - confirmation that server is running (based on `[server]` log prefixes)
- If startup fails due to missing dependencies, suggest installation, but do not run it without explicit user approval.

## Local Testing From Console

- Preferred local startup command:
  - `./start.sh`
- This wraps `npm run dev` from repo root and shows all component logs in one terminal.
- Expected log prefixes:
  - `[client]` Vite startup + URL
  - `[server]` websocket/tick + connect/disconnect lifecycle logs
- Current limitation:
  - Opening the browser client alone does not yet connect to server WebSocket.
- To verify server connect/disconnect logs manually while stack is up, use:
  - `node -e 'const ws=new WebSocket("ws://127.0.0.1:9003");ws.onmessage=(e)=>{console.log(e.data);setTimeout(()=>ws.close(),1000);};'`
