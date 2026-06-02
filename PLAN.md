# PLAN: Migrate coding-containers off dead control-plane forward → jobs-daemon

STATUS: studied. Building.

## Problem (verified)
`POST /api/v1/coding-containers` → 521. The route (`packages/cloud-api/v1/coding-containers/route.ts`)
HTTP-forwards `${CONTAINER_CONTROL_PLANE_URL}/api/v1/containers` to a DEAD origin
(orphan `container-control-plane` :8791, retired in the cloud migration, pointed at
decommissioned .246; secrets unrecoverable). Node autoscaling + warm pool ALREADY
migrated to the `eliza-provisioning-worker` daemon (jobs-table + Redis) and it's HEALTHY.
Only coding-containers CRUD never migrated off the HTTP forward.

## KEY ARCHITECTURAL FINDING (drives the design)
The daemon's agent-provision path (`JOB_TYPES.AGENT_PROVISION` →
`elizaSandboxService.provision()`) **already docker-runs an arbitrary image**:
`provision()` passes `dockerImage: rec.docker_image` into `(await getProvider()).create({...})`
(eliza-sandbox.ts:792). The provider IS the daemon's SSH+docker machinery (node select +
`docker run`). So a coding-container is just an `agent_sandboxes` row with a custom
`docker_image` + coding env vars, provisioned through the SAME healthy daemon path.

Template to copy: `packages/cloud-api/v1/eliza/agents/[agentId]/provision/route.ts`
(create-or-reuse sandbox row → `enqueueAgentProvisionOnce` → `triggerImmediate` →
client polls `/api/v1/jobs/{jobId}`; warm-pool fast path; worker-health gate).

`enqueueLifecycleJob` REQUIRES a pre-existing `agent_sandboxes` row (throws
"Agent not found"), so CREATE must first persist the row via
`elizaSandboxService.createAgent({ ..., dockerImage })`, THEN enqueue provision.

## Design
1. **Image allowlist (security, the real gap)** — `containers-env` getter
   `codingContainerImageAllowlist()` reading `CODING_CONTAINER_IMAGE_ALLOWLIST`
   (comma-sep glob prefixes). Default:
   `ghcr.io/dexploarer/*,ghcr.io/elizaos/*,ghcr.io/waifufun/*`.
   Helper `isCodingContainerImageAllowed(image, allowlist)` in cloud-shared
   coding-containers service. Route rejects disallowed images with **403**.
   (Today: `image` is taken raw with ZERO validation, gated only by "any authed org".)

2. **Rewrite `coding-containers/route.ts`** — replace the dead `forwardContainerCreate`
   with: validate body → resolve image (request override → coding runner image →
   default) → **allowlist check (403 on fail)** → `createAgent({dockerImage,env})`
   → `enqueueAgentProvisionOnce` + `triggerImmediate` → poll job for synchronous
   result (MAX_WAIT≈90s) → build `CloudCodingContainerSession` from the running
   sandbox row. No new HTTP origin; everything via the healthy daemon + DB.

3. **JOB_TYPE(s)** — task asked for `CODING_CONTAINER_CREATE`. Decision:
   the *create* reuses `AGENT_PROVISION` (proven, already image-capable) to avoid
   duplicating the entire provider machinery. We DO add a thin
   `JOB_TYPES.CODING_CONTAINER_CREATE` alias + types for forward-compat / explicit
   telemetry **only if** it's low-risk; if it would mean re-implementing
   provider.create on the daemon, we skip it and document the reuse (honesty over
   ceremony). Status job = existing `GET /api/v1/jobs/{id}` + sandbox status.

4. **Dead-forwarding crons** (deployment-monitor, process-provisioning-jobs,
   pool-replenish) — `triggerImmediate` already prefers the control-plane URL then
   falls back to the cron-secret path; audit each cron's dead `${CONTROL_PLANE_URL}`
   call and no-op / redirect it so it stops 521ing.

## Daemon update procedure (do NOT deploy here; for PR body)
Changed files are cloud-shared/cloud-api TS bundled by the daemon. To ship:
`scp` changed `.ts` → `eliza-1` (88.99.82.102) `/opt/eliza/packages/...`, then
restart `eliza-provisioning-worker.service`. Sol/Shadow deploy, not this PR.

## Out of scope
The `*.waifu.fun` public-URL 502 is SEPARATE. This PR only makes the DEPLOY CALL work.
