# ElizaOS App Examples

This folder contains **simple chat** examples for different desktop/mobile shells.

## Setup (monorepo)

From the repo root:

```bash
bun install
bunx turbo run build --filter=@elizaos/core --filter=@elizaos/plugin-*
```

## Capacitor

Path: `examples/app/capacitor/`

- Frontend: Vite + React
- Backend agent: TypeScript `AgentRuntime` (Bun) over HTTP
- Storage: `@elizaos/plugin-localdb`

See `examples/app/capacitor/README.md`.

## Electron

Path: `examples/app/electron/`

- Renderer: Vite + React
- Backend agent: Electron main process `AgentRuntime` (IPC bridge via preload)
- Storage: `@elizaos/plugin-localdb` under Electron `userData/`

See `examples/app/electron/README.md`.

## Tauri

Path: `examples/app/tauri/`

- Frontend: Vite + React
- Backend agent: Rust `elizaos::AgentRuntime` in native layer (Tauri commands)
- Storage: simple app-level `chat_history.json` in app data dir

See `examples/app/tauri/README.md`.

