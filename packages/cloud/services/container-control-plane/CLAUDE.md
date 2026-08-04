# @elizaos/container-control-plane

Node/Bun sidecar that runs the container mutations Cloudflare Workers can't.
The cloud Worker is on Cloudflare and cannot reach Hetzner Docker nodes (the
Hetzner-Docker client needs SSH), so when `CONTAINER_CONTROL_PLANE_URL` is set,
Worker routes forward container create/delete/restart/env/logs/metrics plus the
provisioning/warm-pool/autoscale cron jobs to this Hono app. It owns only the
Node-only operations; Worker-safe reads stay on the Worker.

## Layout

- `src/index.ts` — the entire service: a single `Hono` app served via `Bun.serve`.
  - Parses/validates JSON request bodies (the `read*` / `to*` helpers) into the
    typed inputs from `@elizaos/cloud-shared`.
  - Delegates work to `cloud-shared` services — `getHetznerContainersClient()`,
    `dockerNodeManager`, `getNodeAutoscaler()`, `provisioningJobService`,
    `WarmPoolManager`, `elizaSandboxService`.
  - Maps `HetznerClientError.code` to HTTP status via `errorStatus`.

There is no built `dist`; `main` points at `src/index.ts` and Bun runs the TS
directly.

## Routes (high level)

- `GET /health` — liveness.
- `GET|POST /api/v1/cron/*` — `deployment-monitor`, `agent-hot-pool`,
  `node-autoscale`, `process-provisioning-jobs`, `pool-replenish`,
  `pool-drain-idle`, `pool-health-check`, `pool-image-rollout`.
- `GET /api/v1/admin/warm-pool`, `GET /api/v1/admin/warm-pool/rollout-status`.
- `POST /api/v1/admin/docker-nodes/:nodeId/health-check`.
- `/api/v1/containers` + `/api/v1/containers/:id` (POST/GET/DELETE/PATCH) and
  `/:id/logs`, `/:id/metrics`, `/:id/workspace-sync`.
- Eliza sandbox bridge: `DELETE /api/compat/agents/:id`,
  `POST /api/v1/eliza/agents/:id/bridge`, `POST /api/v1/eliza/agents/:id/stream`
  (SSE).

## Scripts

Scope every command with `--cwd`:

```bash
bun run --cwd packages/cloud/services/container-control-plane start      # bun run src/index.ts
bun run --cwd packages/cloud/services/container-control-plane dev        # --watch
bun run --cwd packages/cloud/services/container-control-plane typecheck  # tsc --noEmit
bun run --cwd packages/cloud/services/container-control-plane lint       # biome check
bun run --cwd packages/cloud/services/container-control-plane test       # bun test (src/*.test.ts)
```

Tests are colocated bun:test files under `src/` (e.g.
`src/require-internal-token.test.ts`, the H4 fail-closed token-gate proof).
They run in the PR-lane cloud sweep (`bun run test:cloud` via
`packages/scripts/test-cloud-run.mjs`) and in the workspace `test` script.

## Conventions / gotchas

- **Listen address.** Defaults to `127.0.0.1` and port `8791`
  (`PORT` / `CONTAINER_CONTROL_PLANE_PORT`, host via `HOST`). Bun's
  `idleTimeout` is clamped to 1–255s
  (`CONTAINER_CONTROL_PLANE_IDLE_TIMEOUT_SECONDS`, default 255).
- **Auth is header-forwarded, not session-based.** User-facing routes go through
  `requireForwardedAuth`, which requires `x-eliza-user-id` and
  `x-eliza-organization-id` (401 otherwise). Cron/admin routes use
  `handleInternal`. Both first call `requireInternalToken`: when
  `CONTAINER_CONTROL_PLANE_TOKEN` is set, the request must carry a matching
  `x-container-control-plane-token` or it's rejected 401. Errors are thrown as
  `Response` objects and caught by `handle` / `handleInternal`.
- **Per-request DB binding (pinned, fail-closed, H4/#12882).** If a request
  sends `x-eliza-cloud-database-url`, the handler runs inside
  `runWithCloudBindingsAsync({ DATABASE_URL })` and first mirrors Docker-node
  rows via `mirrorControlPlaneNodes`. The forwarded URL is NOT trusted blindly:
  `resolveForwardedDatabaseUrl` runs it through `evaluateForwardedDatabaseUrl`
  (`cloud-shared/.../forwarded-database-url-guard`), which only honors a URL
  whose whole identity (scheme, credentials, host, port, database, query)
  matches the sidecar's own configured `DATABASE_URL` or the
  `CONTAINER_CONTROL_PLANE_DATABASE_URL_ALLOWLIST`. Any other/malformed identity
  (including a different db/user or a `?host=`-override on the same host) is
  rejected 403. Without the header the sidecar relies on its own configured
  `DATABASE_URL`.
- **`@elizaos/cloud-shared` is the brain.** This package adds HTTP plumbing,
  validation, and error/status mapping only — container logic, SSH, warm pool,
  autoscaling, and provisioning all live in `cloud-shared`. Behavioral changes
  usually belong there, not here.
- **Env (set on the deployed sidecar, not the Worker):** `DATABASE_URL`,
  `CONTAINER_CONTROL_PLANE_TOKEN`, `CONTAINERS_SSH_KEY` /
  `CONTAINERS_SSH_KEY_PATH`, `CONTAINERS_SSH_USER`, `ELIZA_AGENT_IMAGE`,
  `ELIZA_AGENT_HOT_POOL_PREPULL` (set `false` to disable pre-pull),
  `HCLOUD_TOKEN`, `CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY`,
  `CONTAINERS_BOOTSTRAP_CALLBACK_URL`, `CONTAINERS_BOOTSTRAP_SECRET`, and the
  private-registry vars `CONTAINERS_REGISTRY_USERNAME` +
  `CONTAINERS_REGISTRY_TOKEN` / `CONTAINERS_REGISTRY_TOKEN_FILE`. See
  `README.md` for the full deployment matrix.
- Node health checks were intentionally moved out of the `agent-hot-pool` route
  to the provisioning-worker daemon to avoid racing status writes — see the
  comment in `agentHotPoolResponse` before re-adding them here.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
