# PLAN: Migrate coding-containers off dead control-plane forward → jobs-daemon

STATUS: scaffolding (study in progress)

## Problem
POST /api/v1/coding-containers → 521. CF worker forwards to dead origin
(container-control-plane :8791, retired, pointed at decommissioned .246).
Node autoscaling already migrated to eliza-provisioning-worker daemon (jobs-table + Redis).
Only coding-containers CRUD + a few crons never migrated.

## Approach (copy AGENT_MESSAGE synchronous pattern from #8150)
1. JOB_TYPES.CODING_CONTAINER_CREATE (+_DELETE/_STATUS if straightforward)
2. Daemon execute fn: docker op on a node via daemon's EXISTING node-SSH+docker machinery
3. Rewrite coding-containers/route.ts: enqueue + triggerImmediate + poll (synchronous)
4. Image allowlist: CODING_CONTAINER_IMAGE_ALLOWLIST env, default ghcr.io/{dexploarer,elizaos,waifufun}/*, reject else 403
5. Crons (deployment-monitor, process-provisioning-jobs, pool-replenish): migrate/no-op dead calls
6. Typecheck cloud-api + cloud-shared

## Daemon update procedure (do NOT deploy here; note in PR)
scp changed .ts → eliza-1 (88.99.82.102) /opt/eliza/packages/... then restart daemon.

(TBD: fill in actual job-type shapes + SSH/docker machinery reuse after study)
