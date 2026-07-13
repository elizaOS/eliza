# Managed dedicated staging canary

`managed-dedicated-canary.ts` is the canonical live proof for the managed
Cloud dedicated-agent path. The workflow is manual, daily-scheduled, or run by
an explicit maintainer label at `.github/workflows/managed-dedicated-canary.yml`.

The lane deliberately does not call Hetzner. It presents the existing
repository Cloud bearer to the staging Worker; the deployed managed
provisioner owns its normal Headscale/container path. This keeps the canary
independent of `HCLOUD_TOKEN_CI`, the apps-project token, and production
control-plane credentials. It creates no user or organization: the repository
credential's existing identity owns the one temporary agent, so there is no
disposable identity row to leak or clean separately.

## Safety and pass contract

- Target is hard-pinned to `https://api-staging.elizacloud.ai`; production is
  refused even when a valid credential is supplied.
- Fixed workflow concurrency plus a prefix scan allows at most one canary. A
  leftover canary makes the next run red before another create can spend.
  Provision/readiness and cleanup use shared absolute deadlines; the workflow
  caps control-plane calls at 30 seconds and has a 45-minute hard cap that
  leaves room for `finally` cleanup.
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
- `finally` re-reads and matches both the in-memory ID and unique name before
  deleting. An asynchronous delete job is polled and a final `404` is required.
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

The older `packages/app/scripts/cloud-provisioning-e2e.mjs` and
`live-cloud-provision-smoke.ts` omit the canonical tier flag. They remain
shared/status-oriented coverage and must not be cited as dedicated evidence.
