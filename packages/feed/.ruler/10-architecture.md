# Architecture & Boundaries

## State (target vs current)

- **Target (in progress)**: Elysia host in `apps/server`, background workers in `apps/daemon`, dedicated `apps/agents`, domain split into `packages/core/*` with `packages/shared/infra` wiring.
- **Current**: Next.js app `apps/web` hosts UI + API routes/SSE/A2A; CLI in `apps/cli`. Domain/engine in `packages/engine` and `packages/agents` (+ `packages/a2a`, `packages/mcp`). Infra/util in `packages/api`, `packages/shared`, `packages/db`. On-chain in `packages/contracts`. Tests in `packages/testing`.

## Dependency direction

`apps/* → packages/* → packages/contracts`

- Apps import from packages; keep them wiring-only.
- Packages must remain framework-free (no Next/React/Elysia imports in domain).
- Avoid circular dependencies.

## Where to put code

- **Domain rules / game logic**: `packages/engine`, `packages/agents` (target: `packages/core/*`).
- **Infra adapters (db/redis/http/sse/auth)**: `packages/api`, `packages/db`, `packages/shared`.
- **UI and route wiring**: `apps/web` (target: `apps/server`).
