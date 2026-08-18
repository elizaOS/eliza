# Managed dedicated staging canary

`managed-dedicated-canary.ts` is the canonical live proof for the managed
Cloud dedicated-agent path. It is an explicit operator-run diagnostic and is
not part of routine pull-request or scheduled CI. Dispatch `Live Smoke` with
the `dedicated` suite (`all` also includes it); the consolidated
`.github/workflows/live-smoke.yml` is its only workflow owner.

The lane deliberately does not call Hetzner. It presents the existing
repository Cloud bearer to the staging Worker; the deployed managed
provisioner owns its normal Headscale/container path. This keeps the canary
independent of `HCLOUD_TOKEN_CI`, the apps-project token, and production
control-plane credentials. It creates no user or organization: the repository
credential's existing identity owns the one temporary agent, so there is no
disposable identity row to leak or clean separately.

## Safety and pass contract

- Target is hard-pinned to `https://api-staging.eliza.app`; production is
  refused even when a valid credential is supplied.
- Fixed workflow concurrency plus a prefix scan allows at most one canary. A
  leftover canary makes the next run red before another create can spend.
  Provision/readiness and cleanup use shared absolute deadlines; the workflow
  caps control-plane calls at 30 seconds and has a 45-minute hard cap that
  leaves room for `finally` cleanup.
- A maintainer may recover one investigated leftover by dispatching with its
  exact deterministic suffix (`r<run-id>a<attempt>`) in the
  `stale_canary_suffix` input. Recovery requires exactly one prefix match,
  verifies ID, full name, creation timestamp, and
  `dedicated-always` tier with a fresh GET, then sends those immutable identity
  fields through the normal authenticated DELETE/job path. The lifecycle
  transaction rechecks them under the per-agent lock and atomically refuses
  replacement-cleanup, active warm-claim, and non-quiescent lifecycle-work
  fences. A final 404 is required before the fresh canary can be created.
  Invalid, absent, mismatched, shared-tier, active, or multiple identities fail
  closed without deleting anything. The privacy-safe artifact records only
  requested/match/accepted-or-ambiguous/confirmed state; it never records the
  suffix, name, IDs, timestamps, or job IDs.
- For recovery without a replacement canary, set `cleanup_only: true` and the
  exact `stale_canary_suffix`. Cleanup-only is exclusive: the dedicated job
  runs regardless of the stale `suite` selector, while every app, scenario,
  voice, cloud, and shared-onboarding job is suppressed. The workflow also
  proves that staging contains commit
  `aada8198bc10045c8c841ea4d6dab974ac2a3319`, the minimum conditional-delete
  API contract, before accepting the destructive result. Cleanup-only evidence
  is schema version 3 with `operation: cleanup-only` and requires one accepted,
  confirmed deletion, zero created agents, zero chat requests, zero live paths,
  no create/readiness/inference timings, final absence, and no possible orphan.
  The workflow performs this ancestry check before the DELETE-capable process
  can start and binds that exact health commit into the process; if staging
  changes between preflight and execution, cleanup stops before listing or
  deleting an agent. The post-run ancestry check remains defense in depth.
- Create sends top-level `alwaysOn: true`, `forceCreate: true`, and
  `autoProvision: true`. The returned and final tier must both be
  `dedicated-always`.
- Readiness requires `running`, database `ready`, a heartbeat no older than the
  platform's 120-second disconnect window, and a Headscale address in the
  `100.64.0.0/10` mesh range.
- One nonce-bearing bridge proof and one nonce-bearing SSE proof must complete.
  Each path has at most two attempts (four top-level chat requests total). Canned,
  fallback, degraded, echo, wrong-transport, missing-token, and incomplete SSE
  responses are red.
- `finally` waits for the known provision job to complete, then re-reads and
  matches the in-memory ID, unique name, tier, and creation timestamp before
  deleting. It never deletes over an active or recently detached lifecycle
  execution. An asynchronous delete job is polled and a final `404` is required.
  Cleanup failure overrides any earlier pass.
- If the create POST may have committed before its response was lost, the
  canary retries exact-name discovery within both a wall-clock and attempt cap.
  It cleans a uniquely recovered row; an unresolved outcome is explicitly
  `cleanup.failed` with `possibleOrphan: true`, never `not-required`.
  Any later deletion/confirmation failure also marks `possibleOrphan: true`.
- The artifact contains only the deployed commit, booleans/path labels, bounded
  request counts, phase timings, and sanitized failure codes. It never contains
  credentials, prompts, replies, IDs, names, URLs, or hostnames.
  A separate exact-schema privacy validator accepts sanitized red or green
  evidence, rejects unknown fields recursively, and must pass before the
  artifact upload step is allowed to run. Attempted phases record their elapsed
  time even when they fail.

## Evidence mapping

| Acceptance | Evidence field / enforcement |
| --- | --- |
| exact deployed Cloud version | `deployedCommit`, verified as an ancestor of the exact workflow SHA |
| canonical dedicated tier | `path.requestedTier` + `path.observedTier` |
| live container + database | `path.running` + `path.databaseReady` |
| fresh heartbeat + mesh ingress | `path.heartbeatFresh` + `path.meshAddressPresent` |
| real central bridge turn | proof-token classifier + allowed `path.bridgeTransport` |
| real dedicated SSE turn | proof-token classifier + `path.sseCompleted` |
| bounded capacity and inference cost | `capacity.maxCreatedAgents=1`, `capacity.maxChatRequests=4` |
| exact cleanup | `cleanup.status=passed` after delete-job completion and final `404` |
| ambiguous create | bounded exact-name recovery; unresolved is `cleanup.failed` + `possibleOrphan` |
| missing/skip/zero fail closed | credential preflight plus independent post-run evidence validator |
| cleanup-only isolation | `operation=cleanup-only`, exclusive workflow job gates, minimum deployed conditional-delete commit, and zero create/path/chat evidence |

The older `packages/app/scripts/cloud-provisioning-e2e.mjs` and
`live-cloud-provision-smoke.ts` omit the canonical tier flag. They remain
shared/status-oriented coverage and must not be cited as dedicated evidence.
