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

## 8. Verification status (honest)

Confirmed in this environment (no cloud credentials needed):

- `agent-backup-diff.test.ts` — **21/21 pass** (vitest).
- cloud-e2e mock-stack — provision / deprovision / stuck-cleanup / dashboard
  (baseline) **green** after the KMS fix; new sleep-wake / scheduled-backup /
  suspend-resume specs **green** (Hetzner + control-plane + PGlite + ioredis
  mocks; `MemorySandboxProvider`).
- `typecheck:cloud` clean for all touched files.

**Cannot be confirmed here (requires secrets / live infra):** real Hetzner
server create/teardown, real Neon branch provisioning, real R2 backup offload,
and the production Cloudflare Worker deploy. These are exercised by the gated
nightly `.github/workflows/hetzner-e2e.yml` against live Hetzner. Running the
real-infra path is the remaining step for 100% production confidence and needs
`HCLOUD_TOKEN` + Neon/R2/Cloudflare credentials.

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
