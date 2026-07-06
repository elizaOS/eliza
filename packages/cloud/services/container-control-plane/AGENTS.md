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
bun run --cwd packages/cloud/services/container-control-plane typecheck  # tsgo --noEmit
bun run --cwd packages/cloud/services/container-control-plane lint       # biome check
```

There are no tests in this package.

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

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
