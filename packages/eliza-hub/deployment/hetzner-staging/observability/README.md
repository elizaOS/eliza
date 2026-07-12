# Observability

These files are staging-ready Prometheus examples for the private Eliza Hub
deployment. They do not include secrets or public hostnames.

## Files

- `prometheus.yml` shows the private scrape target for Merge Steward.
- `merge-steward-alerts.yml` defines readiness, persistence, strict
  work-reservation posture, strict Work-item posture, worker lease, queue backlog, agent
  performance/routing, and failed-run alerts.

Alert annotations use a staging-owned placeholder runbook URL:
`https://git.staging.example.invalid/eliza-hub/runbooks/observability`.
Replace it with the internal Eliza Hub runbook URL on the deployment host; do
not point production alerts at a personal GitHub repository.

## Metrics Auth

Keep `MERGE_STEWARD_METRICS_AUTH_REQUIRED=true` outside local demos. Place the
same private token used for `MERGE_STEWARD_API_TOKEN` in Prometheus at:

```text
/etc/prometheus/secrets/merge-steward-token
```

Do not commit the token file.

## Validation

On a host with Prometheus tooling installed:

```bash
cd deployment/hetzner-staging/observability
promtool check config prometheus.yml
promtool check rules merge-steward-alerts.yml
```

After deploying Merge Steward, run:

```bash
npm run doctor --prefix services/merge-steward -- <steward-url>
```

The doctor should report `ok=true` for readiness, discovery, OpenAPI, required
metrics, workflow, project board, merge queue, agent insights, agent capacity,
agent performance, agent routing, agent cockpit, agent action plan, agent
submission gate, CI failure analysis, PR brief, review assignment, search,
patch conflict prediction, and agent inbox API checks before Prometheus alerts
are treated as meaningful release evidence.

Then confirm Prometheus can scrape:

```bash
curl -fsS -H "Authorization: Bearer $MERGE_STEWARD_API_TOKEN" <steward-url>/metrics
```

## Alert Response

- `ElizaMergeStewardDown`: check the container, reverse proxy, and private
  network route from Prometheus to `merge-steward:8080`.
- `ElizaMergeStewardNotReady`: inspect `/ready`; runtime preflight failures are
  release blockers before routing traffic.
- `ElizaMergeStewardReadinessCheckFailed`: use the failing check name to decide
  whether the queue store, runtime config, or worker lease is unhealthy.
- `ElizaMergeStewardMetricCollectionErrors`: `/metrics` is reachable, but one
  backing store read failed. Check Postgres connectivity first.
- `ElizaMergeStewardProductionNotOnPostgres`: stop the production rollout until
  `DATABASE_URL` or `MERGE_STEWARD_DATABASE_URL` points at Postgres.
- `ElizaMergeStewardWorkerWithoutLiveIntegration`: either disable the worker or
  enable the full live integration path with required checks and bot token
  review.
- `ElizaMergeStewardLiveIntegrationWithoutStrictReservations`: set
  `MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true` or disable live
  integration before allowing agent merges.
- `ElizaMergeStewardLiveIntegrationWithoutStrictWorkItems`: set
  `MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true` or disable live
  integration before allowing agent merges.
- `ElizaMergeStewardLiveIntegrationWithoutAgentBranchNamespaces`: set
  `MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true` or disable live
  integration before allowing agent merges.
- `ElizaMergeStewardLiveIntegrationWithoutVerifiedAgentRunReceipts`: set
  `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` and configure the
  receipt secret named by `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV`, or
  disable live integration before allowing agent merges.
- `ElizaMergeStewardLiveIntegrationWithoutAgentIdentityRegistry`: set
  `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` and configure
  `MERGE_STEWARD_AGENT_IDENTITY_REGISTRY`, or disable live integration before
  allowing agent merges.
- `ElizaMergeStewardAgentIdentityRegistryEmpty`: add at least one allowed Eliza
  agent id to `MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` before allowing live agent
  merges.
- `ElizaMergeStewardWorkerLeaseDisabled`: keep production workers leased so two
  replicas cannot execute live merge work at once.
- `ElizaMergeStewardWorkerLeaseMissing`: check whether every worker is failing
  lease acquisition, stuck during startup, or unable to reach the queue store.
- `ElizaMergeStewardExpiredAgentClaims`: release or reclaim stale agent work
  ownership before assigning more agents to the same resource.
- `ElizaMergeStewardAgentPerformanceNeedsTriage`: inspect
  `/api/agent-performance`; release stale claims or route failed runs before
  new assignment suggestions are trusted.
- `ElizaMergeStewardNoRoutableAgents`: inspect `/api/agent-routing`; blocked
  agent reasons explain whether the issue is capacity, failed runs, stale
  claims, or performance triage.
- `ElizaMergeStewardReadyQueueBacklogHigh`: inspect required checks, runner
  capacity, and human approvals before increasing worker concurrency.
- `ElizaMergeStewardFailedRunsPresent` and
  `ElizaMergeStewardFailedAttemptsPresent`: inspect run/attempt events and
  retry only after confirming the failed integration state is safe.
