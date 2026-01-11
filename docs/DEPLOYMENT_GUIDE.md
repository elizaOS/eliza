# Deployment Guide (ElizaOS)

## Overview

This repository ships deployment-ready **example projects** under `packages/elizaos/examples/`. These examples demonstrate how to embed `@elizaos/core` into:

- a local CLI chat app
- serverless functions (AWS Lambda)
- container workloads (GCP Cloud Run-style Docker build)
- web apps (Next.js example)

The TypeScript runtime (`AgentRuntime`) is designed to run in both long-lived and serverless contexts.

## Core deployment pattern

Regardless of target, the pattern is:

1. **Create a character**
   - Provide at least `name` and optionally `bio`, `system`, settings, secrets.
2. **Instantiate runtime**
   - `new AgentRuntime({ character, plugins: [...] })`
3. **Initialize**
   - `await runtime.initialize({ skipMigrations?: boolean })`
4. **Ensure a connection**
   - Use `runtime.ensureConnection(...)` so entities/rooms/worlds exist.
5. **Process messages**
   - Create `Memory` (often with `createMessageMemory(...)`)
   - Call `runtime.messageService.handleMessage(runtime, message, callback)`

See:

- Local CLI example: `packages/elizaos/examples/chat/typescript/chat.ts`
- AWS Lambda example: `packages/elizaos/examples/aws/typescript/handler.ts`

## Environment variables and secrets

Secrets/config are accessed through `runtime.getSetting(...)` and/or character settings/secrets. In the TypeScript runtime initialization, persisted settings from the database are merged back into the runtime’s character (see `AgentRuntime.initialize()` in `packages/typescript/src/runtime.ts`).

General guidance:

- Do not commit secrets to git.
- Prefer deploying secrets via your platform’s secret manager (Lambda env vars, Cloud Run secrets, etc.).

## Database and migrations

The TypeScript runtime requires a database adapter at initialization time. Commonly this is provided by `@elizaos/plugin-sql`.

At init, the runtime can run plugin migrations unless you pass:

```ts
await runtime.initialize({ skipMigrations: true });
```

This can be useful for serverless environments where migrations are managed externally or where cold-start time matters.

## Serverless (AWS Lambda)

The example `packages/elizaos/examples/aws/typescript/handler.ts` uses a **singleton runtime** reused across invocations:

- `let runtime: AgentRuntime | null = null;`
- lazy `initializeRuntime()` builds and initializes once
- each request:
  - ensures connection (user + room)
  - creates message memory
  - calls `messageService.handleMessage(...)`

This pattern reduces cold-start overhead and avoids re-running migrations on every request.

## Containers (GCP Cloud Run-style)

The example `packages/elizaos/examples/gcp/typescript/Dockerfile` shows a standard two-stage build:

- build stage installs dependencies and compiles to `dist/`
- production stage copies `dist/` + installs production deps
- container runs `node dist/handler.js`

Use this pattern for any container target (Cloud Run, ECS, Kubernetes).

## Web apps (Next.js)

The Next.js example lives under `packages/elizaos/examples/next/`. It demonstrates integrating a chat route with a runtime.

Important considerations for web/serverless runtimes:

- Ensure the database adapter you choose works in your environment.
- Use a singleton runtime per server process where possible.
- Consider skipping migrations in edge runtimes.

## Getting started via templates

The `elizaos` package in this repo is an **example scaffolder** (commands: `create`, `info`, `version`) located at `packages/elizaos/`.

Use it to copy an example project into a new directory, then follow that example’s `package.json` scripts (for instance, the chat example uses `bun run chat.ts`).

