# Electron Backend Package

Electron main-process package for the Electron chat example. It starts the
elizaOS `AgentRuntime`, provides the IPC bridge, and loads the renderer.

## Run

```bash
cd packages/examples/app/electron/backend
bun install
bun run dev
```

For a no-dev-server run, build the frontend first and then run:

```bash
bun run start
```

## Validate

```bash
bun run typecheck
bun run test
bun run build
```

See [`../README.md`](../README.md) for the full Electron app workflow.
