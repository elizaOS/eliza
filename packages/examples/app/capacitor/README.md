# ElizaOS Chat (Capacitor example)

This example is a **simple chat UI** (frontend) talking to a **local AgentRuntime backend** over HTTP.

- **Frontend**: Vite + React (runs in Capacitor WebView)
- **Backend agent**: TypeScript `AgentRuntime` (Bun/Node) using `@elizaos/plugin-localdb` for persistence
- **LLM selection**: ELIZA classic fallback when no API key is configured

## Structure

- `frontend/`: Vite React app (Capacitor web app)
- `backend/`: Bun HTTP server hosting the elizaOS agent

## Run (dev)

### One-time monorepo setup

From the repo root:

```bash
bun install
bunx turbo run build --filter=@elizaos/core --filter=@elizaos/plugin-*
```

In one terminal:

```bash
cd examples/app/capacitor/backend
bun install
bun run dev
```

In another terminal:

```bash
cd examples/app/capacitor/frontend
bun install
bun run dev
```

Open the UI at `http://localhost:5176`. The backend defaults to `http://localhost:8787`.

### Persistence location

The backend uses `@elizaos/plugin-localdb` and writes JSON files to:

- `LOCALDB_DATA_DIR` (if set), otherwise `examples/app/capacitor/backend/.eliza-localdb`

## Capacitor (optional)

Initialize platforms as usual (not included in this repo snapshot):

```bash
cd examples/app/capacitor
bun install
bunx cap add ios
bunx cap add android
bun run build:frontend
bunx cap sync
```

Then open with:

```bash
bunx cap open ios
bunx cap open android
```

## Deploy

- **Web build**: `bun run build:frontend` (from `examples/app/capacitor/`)
- **iOS/Android**: `bunx cap sync` then `bunx cap open ios|android`, and build/archive from Xcode / Android Studio

