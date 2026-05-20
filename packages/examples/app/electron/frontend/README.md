# Electron Frontend Package

Vite React renderer for the Electron chat example.

## Run

```bash
cd packages/examples/app/electron/frontend
bun install
bun run dev
```

## Validate

```bash
bun run test
bun run typecheck
bun run build
```

The local smoke test checks the Vite mount point and preload bridge calls. See [`../README.md`](../README.md) for the Electron main-process workflow.
