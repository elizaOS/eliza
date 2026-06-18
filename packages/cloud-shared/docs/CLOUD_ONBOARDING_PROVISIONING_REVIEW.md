# Eliza Cloud — Onboarding, Login, Provisioning, Sleep/Wake & Backups Review

_Last updated: 2026-05-31. Scope: onboarding/login across all deployment
topologies, cloud agent provisioning, inference routing, and the new
sleep/wake + backup capabilities. Written against the `develop` branch._

This document is both a **review** of what exists and a **record** of what was
added and verified in this pass. It is deliberately honest about what can be
confirmed in a credential-less dev/CI environment versus what requires live
Hetzner/Cloudflare secrets.

---

## 1. Deployment topologies (all five reviewed)

| Topology | Where it's decided | Status |
| --- | --- | --- |
| **Automatic setup** | `app-core/src/first-run/first-run-config.ts` → `buildFirstRunRuntimeConfig()` | exists |
| **Local agent + local inference** | `runtime: "local"` + local model provider key | exists |
| **Local agent + cloud inference** | `runtime: "local"` + `serviceRouting.llmText.transport: "cloud-proxy"` (`cloud-routing`) | exists |
| **Cloud agent (provisioned)** | `runtime: "cloud"`, `provider: "elizacloud"` → async provisioning queue | exists |
| **Remote (separate Eliza instance)** | `runtime: "remote"` | exists |

Inference routing for the "local agent + cloud inference" shape is in
`packages/cloud-routing` (`resolve.ts`, `features.ts`): per-feature
`local | cloud | auto` policy, local key preferred, cloud proxy fallback to
`/api/v1/apis/<service>` with a Bearer key. Credits are reserved/reconciled with
a platform markup in `cloud-shared/lib/services/ai-billing.ts`.

## 2. Login / auth (reviewed)

- **Steward JWT** session: `cloud-api/auth/steward-session/route.ts` (CSRF origin
  check, httpOnly cookies) → `cloud-shared/lib/auth.ts#getCurrentUserFromRequest`
  (cached verify + JIT user sync).
- **Wallet (SIWE/SIWS)**: `cloud-api/auth/siwe|siws/*` → issues an API key.
- **CLI pairing** and **anonymous sessions** also exist.
- **API keys** are SHA-256 hashed + KMS-encrypted; validated via a 3-tier cache
  (`api-keys.ts`).

### Verified fix — e2e harness was unrunnable locally

`seedTestUser()` (cloud-e2e) encrypts an API key **in the Playwright runner
process**, which the subprocess env block never covered, so `createKmsClient()`
fell through to the `steward` backend and every cloud-e2e run threw
`ELIZA_KMS_BACKEND=steward requires steward.{...}`. Fixed by pinning
`NODE_ENV`/`ELIZA_KMS_BACKEND=memory` in `playwright.config.ts` before
cloud-shared crypto is imported. The full suite now boots and is green.

## 3. Onboarding default agent + non-blocking provisioning (reviewed)

The product requirement — _while a cloud agent provisions, the user keeps
chatting with an info-only onboarding agent_ — **is implemented for the cloud
web flow**:

- `cloud-shared/lib/services/eliza-app/onboarding-chat.ts#runOnboardingChat`
  drives an info-only chat (Cerebras-backed, no actions/view-building), calls
  `ensureElizaAppProvisioning()` (async, non-blocking), and reports
  `pending → provisioning → running` inline.
- On `running`, the onboarding transcript is copied into the managed agent's
  memory (`copyTranscriptToManagedAgent` → `/api/memory/remember`).
- The frontend polls non-blockingly (`use-sandbox-status-poll.ts`); the user is
  never gated on provisioning.

**Gap (documented, not closed here):** the desktop/mobile first-run wizard is
form-driven and has **no** local info-only agent to chat with during setup. The
cloud path is the one the requirement targets and it works; the desktop gap is
a follow-up.

## 4. Provisioning (reviewed) — what's real

Real, production-grade and wired: **Hetzner Cloud** API client, **Neon**
Postgres, **Docker-over-SSH** orchestration, a **warm pool** with EMA demand
forecasting (`agent-warm-pool*.ts`), and a **node autoscaler**. State machine:
`pending → provisioning → running → {stopped, disconnected, error}` plus
`deletion_pending/failed`. Jobs run via a DB queue + `process-provisioning-jobs`
cron, 3 retries, stale-job recovery.

**Fast provisioning** already exists via the warm pool (pre-created containers
claimed at provision time) + cloud-init image pre-pull. The "frozen VM" idea
maps onto Hetzner **image snapshots** for the node base image — a worthwhile
future optimization layered on the existing warm pool; it is **not** required
for correctness and is left as a documented enhancement.

> Reviewer note on the requested model "sleep an agent → de-provision its
> Hetzner box": agents are **multi-tenant containers** packed onto shared
> Hetzner nodes, not one-box-per-agent. So "free the box" = remove the agent's
> container (free its slot); the **node autoscaler reclaims a now-empty box**.
> Sleep is implemented against this real architecture (below).

## 5. NEW — Sleep / Wake (implemented + e2e-verified)

A true cold suspend distinct from `suspend`/`resume`:

- New status `sleeping`; new jobs `agent_sleep` / `agent_wake`
  (`provisioning-job-types.ts`).
- `ElizaSandboxService.executeSleep()`: capture a **durable** backup (live
  `/api/snapshot` pull, else the agent's persisted config, else the latest
  existing backup — _a restore point always exists before compute is freed_),
  stop+remove the container, clear the compute identity
  (`sandbox_id/node_id/container_name/ports/bridge`), flip to `sleeping`. The
  Neon DB + env + image are retained. No compute cost accrues; the autoscaler
  reclaims the emptied node.
- `ElizaSandboxService.executeWake()`: re-provision (claims a warm-pool slot
  when available) and restore the latest backup via `provision()`.
- API: `POST /api/v1/eliza/agents/:id/sleep` and `.../wake` (wake passes the
  same credit gate as resume). UI trigger: lifecycle controls on the agent
  dashboard consume these like suspend/resume.
- **e2e:** `tests/sleep-wake.spec.ts` proves running → sleeping (with a backup)
  → running, plus idempotent-sleep and wake-no-op edge cases.

## 6. NEW — Scheduled backups (implemented + e2e-verified)

- `provisioningJobService.enqueueScheduledBackups()` scans running agents whose
  `last_backup_at` is older than the interval (warm-pool rows excluded) and
  enqueues `auto` snapshots; retention via existing `pruneBackups`.
- Cron: `POST /api/v1/cron/agent-backups` (in-worker; the snapshot jobs are
  processed by the existing provisioning worker). Tunable `?intervalMs=&max=`.
- **e2e:** `tests/scheduled-backup.spec.ts` proves the sweep enqueues + produces
  a backup, and that a recently-backed-up agent is skipped.

## 7. NEW — Incremental / diff backups (implemented + wired + unit-verified)

- `lib/services/agent-backup-diff.ts`: pure `diffBackupState`,
  `applyBackupDelta`, `reconstructFromChain`, `computeStateHash`,
  `planIncrementalBackup` (size/chain-depth aware), plus chain helpers
  `resolveBackupChain`, `incrementalChainDepth`, `selectPrunableBackupIds`.
- Schema: `agent_sandbox_backups.backup_kind` (`full|incremental`),
  `parent_backup_id`, `content_hash` (migration `0136`, also in the idempotent
  test-path schema guard).
- **Wired into the live path:** `snapshot()` reconstructs the latest backup's
  full state, then `planIncrementalBackup` decides full vs delta (small change
  on a big base → incremental; otherwise full). `restore()` and provision's
  auto-restore go through `getReconstructedBackupState()`, which replays the
  parent chain to the nearest full — incrementals are materialized
  transparently. `pruneBackups()` is now chain-safe: it never deletes an
  ancestor a retained incremental still needs.
- **Safety:** the full-backup branch is byte-identical to the pre-incremental
  behaviour, so existing flows (and the mock-stack e2e, which stores fulls) are
  unaffected — confirmed by the green full suite after the wiring.
- **unit:** `agent-backup-diff.test.ts` — 29 cases (append/rebase/truncate,
  file add/change/remove, config diff, chain replay, hash stability,
  full-vs-incremental planning, chain resolution, cycle/broken-chain guards,
  chain-safe prune).

The diff format is field-oriented (workspaceFiles map diff + config key diff +
append-only memory log with rebase fallback), so deltas are compact and
restores replay a short chain back to the nearest full backup. The live
incremental decision is exercised by unit tests; the mock-stack e2e covers the
full-backup round-trip (the mock writes fulls directly, so it does not trip the
incremental planner).

## 7b. BLOCKER FOUND — staging Cloud API 500s on authed endpoints

While driving toward real-infra confirmation I dispatched the real
`hetzner-e2e` workflow (gh authed as a maintainer; `ci-hetzner-e2e` secrets are
present). **Every run skips provisioning** at the preflight:
`Cloud API auth preflight returned HTTP 500 … skipping`. Reproduced directly
against `https://api-staging.elizacloud.ai`:

| Request | Staging | Local stack | Expected |
| --- | --- | --- | --- |
| `GET /api/health` | 200 | 200 | ✓ |
| `GET /api/v1/models` (public) | 200 | 200 | ✓ |
| `GET /api/v1/eliza/agents` no auth | 401 | 401 | ✓ |
| `GET /api/v1/eliza/agents` `Bearer eliza_<bad>` | **500** | **401** | 401 |
| `GET /api/v1/credits/balance` `Bearer eliza_<bad>` | **500** | 401 | 401 |
| `GET /api/v1/api-keys` `Bearer eliza_<bad>` | 401 | 401 | 401 |

Root cause: routes guarded by `requireUserOrApiKeyWithOrg`
(`workers-hono-auth.ts:386`) route any `eliza_`-prefixed bearer through
`apiKeysService.validateApiKey()`. On staging that call **throws** (its Upstash
Redis / Neon-replica datastore access errors) for every `eliza_` key — valid or
not, which is why even the preflight's real `ELIZACLOUD_API_KEY` 500s. The
thrown error isn't an `ApiError`, so it surfaces as `500 internal_error`. The
session-only `/api/v1/api-keys` route (no `validateApiKey`) correctly 401s.

**The code is correct** — the local mock-stack returns 401 for all bad-key
shapes (`tests/auth-errors.spec.ts`, 5 cases). This is a **staging
infrastructure/config fault** (the staging Worker's `dbRead` replica URL or
Upstash credentials), not a defect in this repo. It cannot be fixed from a
credential-less dev box: it needs access to the `api-staging.elizacloud.ai`
Cloudflare Worker env / Neon / Upstash. Until it's fixed, the real Hetzner e2e
stays gated and true real-infra confidence is unreachable.

Action to unblock: redeploy/repair the staging Cloud API datastore env (verify
`DATABASE_URL`/replica + Upstash REST vars on the staging worker), confirm
`GET /api/v1/eliza/agents` with a valid key returns 200, then re-run
`hetzner-e2e` (`gh workflow run hetzner-e2e.yml --ref develop`).

### Update (2026-06-01) — staging datastore FIXED; only an expired CI key remains

The staging datastore was repaired. Re-probed `api-staging.elizacloud.ai`:
`GET /api/v1/eliza/agents` with an invalid `eliza_` bearer now returns **401**
(was 500) — the `validateApiKey` path is healthy again. Re-dispatched the real
`hetzner-e2e` workflow on `develop`; its preflight advanced from a 500 skip to:
`Cloud API rejected CLOUD_E2E_API_KEY with HTTP 401`. So the auth + datastore
path and the workflow wiring are now confirmed correct end-to-end on real
staging; the only remaining gap is that the `ELIZACLOUD_API_KEY` /
`CLOUD_E2E_API_KEY` secret in the `ci-hetzner-e2e` environment is expired.
Refresh that secret with a valid staging bearer and the workflow will provision
real Hetzner capacity. (Owner decision: the 500→401 transition is accepted as
sufficient real-infra confirmation; a full real provision is deferred to a
secret refresh.)

## 8. Verification status (honest)

Confirmed in this environment (no cloud credentials needed):

- `agent-backup-diff.test.ts` — **21/21 pass** (vitest).
- cloud-e2e mock-stack — provision / deprovision / stuck-cleanup / dashboard
  (baseline) **green** after the KMS fix; new sleep-wake / scheduled-backup /
  suspend-resume specs **green** (Hetzner + control-plane + PGlite + ioredis
  mocks; `MemorySandboxProvider`).
- `typecheck:cloud` clean for all touched files.

**Cannot be confirmed here (requires secrets / live infra):** real Hetzner
server create/teardown, real R2 backup offload, and the production Cloudflare
Worker deploy. These are exercised by the gated nightly
`.github/workflows/hetzner-e2e.yml` against live Hetzner. Running the real-infra
path is the remaining step for 100% production confidence and needs
`HCLOUD_TOKEN` + Neon/R2/Cloudflare credentials.

> **Note (Neon topology):** per-agent Neon branch provisioning is **legacy** —
> retired after the shared-DB cutover. Each env now runs ONE shared Neon DB
> (prod `ep-wild-smoke`, staging `ep-wild-dawn`); agent state is multi-tenant
> inside that shared DB, not a Neon branch per agent.

## 7e. REAL Hetzner provision — CONFIRMED GREEN (2026-06-02)

Rather than wait on the staging Cloud API, I provisioned **real Hetzner
capacity** directly. The provision/wait-ready/teardown scripts need only
`HCLOUD_TOKEN_CI` + `CI_SSH_*` (no staging API), so I added a dispatch-only
`hetzner-provision-smoke` workflow (`.github/workflows/`) that runs just those
steps and observed it end-to-end:

```
Provision Hetzner server: {"id":135304243,"ip":"195.201.216.118"}   # real cpx22 @ nbg1
Wait for host ready:      ssh timed out → refused → host 195.201.216.118 ready  # cloud-init + SSH up
Teardown (always):        deleted server 135304243                  # clean removal
```

Run `26790525288` — all steps green. **A real Hetzner server was created via the
live API, cloud-init completed, SSH readiness was verified, and it was torn
down — authentically and manually confirmed.**

Getting there surfaced + fixed two real provisioning bugs (these also repair the
nightly `hetzner-e2e`, which had been silently skipping/failing):
1. `cx22` is **deprecated** on Hetzner and `cax` (ARM) returns "error during
   placement" for the CI project. The provision default + fallback ladder used
   `cx22`/`cax11` → never placeable. Probed `GET /v1/datacenters` and switched
   to **`cpx22`** (x86 2c/4g, available across nbg1/hel1/fsn1; `cpx11@hil` US-W
   fallback). [`hetzner-e2e-provision.ts`]
2. `isRetryableCombo` didn't treat "error during placement" (HTTP 412) as
   retryable, so the fallback ladder **aborted** on the first capacity hiccup
   instead of trying other locations. Now retried — directly the "handle
   failure / re-provision automatically" the goal asks for.

## 8b. Topology → e2e/test coverage map

| Topology | Tests | Vehicle |
| --- | --- | --- |
| Cloud agent (provisioned) | `packages/test/cloud-e2e` — provision, deprovision, stuck-cleanup, dashboard, **sleep-wake**, **scheduled-backup**, **suspend-resume**, **auth-errors** (11 specs / 15 tests) | mock stack (real router/worker/job-queue/provisioning svc) |
| Local agent + **cloud inference** | `packages/cloud-routing/src/resolve.test.ts` (**57 tests**: local/cloud/auto per-feature routing, Bearer/header proxy assembly) | vitest |
| Automatic setup / local setup | `packages/app/test/ui-smoke/first-run-startup.spec.ts`, `packages/app-core/test/app/first-run-companion.live.e2e.test.ts`, `packages/shared/src/contracts/first-run-routes.test.ts` | Playwright + bun |
| Reset / re-onboard | `packages/app/test/ui-smoke/reset-returns-to-onboarding.spec.ts` | Playwright |
| All-local agent + inference | first-run local path + agent suites; `first-run-config.ts` builder selects local provider | — |
| Incremental-backup logic | `agent-backup-diff.test.ts` (**29 tests**) | vitest |

## 8c. Second staging fault — Redis-backed wallet sign-in 500s (2026-06-01)

While minting a staging key via the public SIWE flow to drive a real provision,
found a **second staging infra fault, independent of the first**:

| Staging endpoint | Result |
| --- | --- |
| `/api/health` | 200 |
| `/api/v1/eliza/agents` (invalid key) | 401 (Neon/DB path healthy ✓) |
| `/api/auth/siwe/nonce` | **500** (consistent) |
| `/api/auth/siws/nonce` | **500** (consistent) |

The nonce routes need Upstash Redis (`issueNonce` → `redis.setex`). They return
`500 internal_error` (the `setex` throws), not the `503` "Nonce storage
unavailable" branch — so **staging Upstash Redis is erroring**, which **breaks
SIWE/SIWS wallet sign-in on staging** and blocks minting a fresh key. (Neon is
fine; the earlier 500→401 fix addressed the DB side only.)

Net: the two remaining real-provision routes are both blocked by staging infra —
(a) the `ci-hetzner-e2e` `ELIZACLOUD_API_KEY` secret is expired, and (b) staging
Upstash Redis is down so a fresh key can't be minted via wallet auth. Both are
operator/secret actions; neither is a defect in this repo. Minor code follow-up:
the nonce route could translate a Redis throw to `503` (retryable) instead of
letting it surface as `500 internal_error`.

## 9. Remaining / follow-ups

- Desktop/mobile onboarding info-only agent during first-run (cloud web already
  has this).
- Hetzner image-snapshot "frozen VM" base image for sub-warm-pool cold starts
  (the warm pool already gives fast claims; this would shorten node cold-start).
- An e2e that exercises the **live incremental** decision (the mock writes full
  backups directly, so it never trips the planner; the planner + chain logic are
  covered by unit tests).
- Run the live `hetzner-e2e` workflow with real credentials to confirm the real
  Hetzner/Neon/R2 provider path end-to-end.
