# Capacitor Backend Package

Local Bun HTTP backend for the Capacitor chat example. It hosts the elizaOS
`AgentRuntime` and exposes chat endpoints consumed by the Vite frontend.

## Run

```bash
cd packages/examples/app/capacitor/backend
bun install
bun run dev
```

The backend defaults to `http://localhost:8787`. Set `LOCALDB_DATA_DIR` to
override the local JSON persistence directory.

## Validate

```bash
bun run typecheck
bun run test
bun run build
```

See [`../README.md`](../README.md) for the full Capacitor app setup.
