# ElizaOS Chat (Electron example)

This example runs an elizaOS **AgentRuntime in the Electron main process** and exposes a tiny IPC bridge to a React renderer chat UI.

- **Persistence**: `@elizaos/plugin-localdb` using a JSON data directory under Electron `userData/`
- **LLM selection**: if the chosen provider has no credentials configured, it falls back to **ELIZA classic**

## Structure

- `backend/`: Electron main + preload (agent + IPC)
- `frontend/`: Vite React renderer (chat UI)

## Run (dev)

### One-time monorepo setup

From the repo root:

```bash
bun install
bunx turbo run build --filter=@elizaos/core --filter=@elizaos/plugin-*
```

Terminal A (renderer):

```bash
cd examples/app/electron/frontend
bun install
bun run dev
```

Terminal B (Electron main):

```bash
cd examples/app/electron/backend
bun install
bun run dev
```

## Run (no dev server)

```bash
cd examples/app/electron/frontend
bun install
bun run build

cd ../backend
bun install
bun run start
```

## Deploy

- **Local packaged run (no dev server)**: `bun run build` in `frontend/`, then `bun run start` in `backend/`
- **Distributables/installer**: wire up a packager (e.g. Electron Forge / electron-builder) on top of `backend/dist` + `backend/renderer` (kept out of this minimal template)

