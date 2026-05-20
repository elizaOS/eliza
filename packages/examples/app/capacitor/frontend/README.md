# Capacitor Frontend Package

Vite React frontend for the Capacitor chat example.

## Run

```bash
cd packages/examples/app/capacitor/frontend
bun install
bun run dev
```

The frontend defaults to the local backend at `http://localhost:8787`. Set
`VITE_CHAT_BACKEND_URL` when the backend runs elsewhere.

## Validate

```bash
bun run test
bun run typecheck
bun run build
```

The local smoke test checks the Vite mount point, provider controls, backend URL fallback, and HTTP chat routes. See [`../README.md`](../README.md) for native Capacitor setup and sync steps.
