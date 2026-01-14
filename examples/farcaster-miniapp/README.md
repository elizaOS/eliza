# Eliza Classic Chat — Farcaster Miniapp (Demo)

This demo is intentionally **chat-only**: no portfolio, swap, bridge, or social feed.

## What it is
- **Frontend**: React + Vite miniapp that shows a single Eliza chat screen.
- **Backend**: Express API with an **in-memory session store** (process memory).

## Running locally

From the repo root:

```bash
bun install
```

In one terminal (API):

```bash
cd examples/farcaster-miniapp
bun run start
```

In another terminal (UI):

```bash
cd examples/farcaster-miniapp
bun run dev
```

Then open the Vite URL (default `http://localhost:3000`).

## Endpoints
- `GET /health`
- `POST /api/chat/eliza` with JSON:
  - `message: string`
  - `sessionId?: string`
  - `userId?: string`

## Tests

```bash
cd examples/farcaster-miniapp
bun run test
```

