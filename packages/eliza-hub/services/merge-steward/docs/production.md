# Merge Steward Production Packaging

The merge steward service is packaged as a Node 24 container. The Docker build
installs runtime dependencies, validates the package, and then produces a
runtime image:

```sh
docker build -f services/merge-steward/Dockerfile -t merge-steward:local .
```

The `verify` build stage runs:

```sh
npm run check
npm test
```

The runtime image uses `node:24-alpine`, copies `package.json`,
`package-lock.json`, `node_modules`, `db/`, and `src/`, sets
`NODE_ENV=production`, exposes `PORT=8787`, and runs as the non-root `node`
user provided by the base image.

## Runtime Configuration

Configure deployments with environment variables. Do not bake tokens, webhook
secrets, host names, or repository-specific values into the image.

| Variable | Purpose | Example placeholder |
| --- | --- | --- |
| `PORT` | HTTP port inside the container. | `8787` |
| `MERGE_STEWARD_DEPLOYMENT_MODE` | Runtime preflight mode: `local`, `staging`, or `production`. | `production` |
| `FORGEJO_BASE_URL` | Forgejo instance base URL used by integration code. | `https://forgejo.example.invalid` |
| `FORGEJO_TOKEN_ENV` | Name of the environment variable containing the bot token. | `FORGEJO_STEWARD_TOKEN` |
| `FORGEJO_WEBHOOK_SECRET_ENV` | Name of the environment variable containing the webhook secret. | `FORGEJO_WEBHOOK_SECRET` |
| `DATABASE_URL` | Optional Postgres URL for the production runtime store. Wins over `QUEUE_STORE_PATH`. | `postgres://steward:...@postgres:5432/steward` |
| `QUEUE_STORE_PATH` | Optional JSON queue-state file for private staging. | `/state/queue.json` |
| `MERGE_STEWARD_API_AUTH_REQUIRED` | Requires bearer auth for non-webhook `/api/*` endpoints. | `true` |
| `MERGE_STEWARD_API_TOKEN_ENV` | Name of the environment variable containing the control API token. | `MERGE_STEWARD_API_TOKEN` |
| `MERGE_STEWARD_METRICS_ENABLED` | Enables the Prometheus text metrics endpoint. | `true` |
| `MERGE_STEWARD_METRICS_AUTH_REQUIRED` | Requires bearer or OIDC auth for `GET /metrics`. | `true` |
| `MERGE_STEWARD_OIDC_ENABLED` | Requires Eliza Cloud-issued JWT support for production control API calls. | `true` |
| `OIDC_ISSUER_URL` | Expected Eliza Cloud OIDC issuer. | `https://cloud.example.invalid` |
| `OIDC_DISCOVERY_URL` | OIDC discovery URL for production, unless `OIDC_JWKS_URL` is configured. | `https://cloud.example.invalid/.well-known/openid-configuration` |
| `OIDC_JWKS_URL` | Optional JWKS URL override. | `https://cloud.example.invalid/jwks` |
| `OIDC_AUDIENCE` | Required JWT audience for steward API calls. | `eliza-merge-steward` |
| `MERGE_STEWARD_OIDC_REQUIRED_ROLES` | Required comma-separated role allowlist; token needs at least one. | `steward` |
| `MERGE_STEWARD_OIDC_REQUIRED_GROUPS` | Required comma-separated group allowlist; token needs at least one. | `eliza-team` |
| `MERGE_STEWARD_OIDC_ADMIN_ROLES` | Required comma-separated roles allowed to perform cross-agent/admin actions. | `steward-admin` |
| `MERGE_STEWARD_OIDC_ADMIN_GROUPS` | Required comma-separated groups allowed to perform cross-agent/admin actions. | `eliza-admins` |
| `MERGE_STEWARD_MAX_BODY_BYTES` | Maximum request body size accepted before buffering. | `1048576` |
| `MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID` | Rejects signed webhooks without a delivery ID header. | `true` |
| `MERGE_STEWARD_EVENT_GATE_ENABLED` | Enables deterministic webhook policy gating before queue mutation. | `true` |
| `MERGE_STEWARD_EVENT_GATE_REPOSITORIES` | Comma-separated repos allowed to mutate queue state. | `elizaos/eliza` |
| `MERGE_STEWARD_EVENT_GATE_TRUSTED_ACTORS` | Comma-separated users allowed to issue steward comment commands. | `maintainer-one,maintainer-two` |
| `MERGE_STEWARD_EVENT_GATE_ALLOWED_KINDS` | Optional comma-separated normalized event kinds. | `pull_request,status,workflow_run` |
| `MERGE_STEWARD_EVENT_GATE_COMMAND_PREFIXES` | Comment command prefixes guarded by trusted actor policy. | `/eliza,/steward` |
| `MERGE_STEWARD_EVENT_GATE_ALLOW_FORKS` | Allows fork PR events to mutate queue state. | `false` |
| `FORGEJO_STEWARD_USERNAME` | Forgejo username used by the steward bot. | `eliza-merge-steward` |
| `FORGEJO_FEEDBACK_ENABLED` | Enables Forgejo label/comment feedback planning. | `false` |
| `FORGEJO_FEEDBACK_DRY_RUN` | Plans feedback without mutating Forgejo. | `true` |
| `FORGEJO_FEEDBACK_LABELS` | Allows steward-owned label syncing when feedback is enabled. | `true` |
| `FORGEJO_FEEDBACK_COMMENTS` | Allows queue comments when feedback is enabled. | `true` |
| `FORGEJO_ENRICHMENT_ENABLED` | Enables read-only PR/file/review/status enrichment. | `false` |
| `FORGEJO_PROTECTED_BRANCHES` | Comma-separated branch names treated as protected by steward policy. | `main,develop` |
| `FORGEJO_REQUIRED_CHECKS` | Optional comma-separated required check contexts. | `smoke,typecheck` |
| `FORGEJO_ENRICHMENT_PAGE_LIMIT` | Page size for Forgejo list endpoints. | `50` |
| `FORGEJO_ENRICHMENT_MAX_PAGES` | Max pages fetched per enrichment list. | `10` |
| `MERGE_STEWARD_INTEGRATION_ENABLED` | Enables integration plan metadata. | `false` |
| `MERGE_STEWARD_INTEGRATION_DRY_RUN` | Keeps integration planning non-mutating. | `true` |
| `MERGE_STEWARD_INTEGRATION_EXECUTOR` | Integration executor adapter. Use `none` or `local-git`. | `none` |
| `MERGE_STEWARD_INTEGRATION_BATCHING` | Allows safe disjoint merge-train plans for more than one ready PR at a time. | `false` |
| `MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE` | Global cap for safe integration batch selection. | `4` |
| `MERGE_STEWARD_INTEGRATION_BRANCH_PREFIX` | Prefix for planned integration branches. | `eliza-queue` |
| `MERGE_STEWARD_INTEGRATION_BRANCH_MODE` | Planned behavior for stale integration branches. | `reset` |
| `MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS` | Allows live execution when no required checks are present. | `false` |
| `MERGE_STEWARD_INTEGRATION_REMOTE_URL` | Git remote URL used by the `local-git` adapter. | `ssh://git@example.invalid/elizaos/eliza.git` |
| `MERGE_STEWARD_INTEGRATION_WORK_DIR` | Work directory for local Git integration worktrees. | `/state/git` |
| `MERGE_STEWARD_INTEGRATION_GIT_BINARY` | Git binary used by the local executor. | `git` |
| `MERGE_STEWARD_INTEGRATION_PUSH_BRANCH` | Allows the local executor to push integration branches. | `false` |
| `MERGE_STEWARD_INTEGRATION_MERGE_METHOD` | Forgejo merge method for final PR merge. | `merge` |
| `MERGE_STEWARD_INTEGRATION_DELETE_BRANCH_AFTER_MERGE` | Deletes the PR source branch after merge when Forgejo permits it. | `false` |
| `MERGE_STEWARD_INTEGRATION_MERGE_TITLE` | Optional final merge commit title. | `Merge via Eliza Steward` |
| `MERGE_STEWARD_INTEGRATION_MERGE_MESSAGE` | Optional final merge commit body. | `Integration branch checks passed.` |
| `MERGE_STEWARD_CHECK_POLL_ATTEMPTS` | Number of status polling attempts for integration checks. | `1` |
| `MERGE_STEWARD_CHECK_POLL_INTERVAL_MS` | Delay between integration check polling attempts. | `0` |
| `MERGE_STEWARD_WORKER_ENABLED` | Starts the merge queue worker loop inside the steward process. | `false` |
| `MERGE_STEWARD_WORKER_ID` | Worker identity recorded on queue claims and runs. | `merge-steward-worker` |
| `MERGE_STEWARD_WORKER_POLL_INTERVAL_MS` | Delay between worker polling iterations. | `5000` |
| `MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION` | Required explicit confirmation before worker auto-claims merge work. | `false` |
| `MERGE_STEWARD_WORKER_MAX_CONSECUTIVE_ERRORS` | Stops the worker after this many consecutive loop errors. | `5` |
| `MERGE_STEWARD_WORKER_LEASE_ENABLED` | Requires a durable worker lease before auto-claiming merge work. | `true` |
| `MERGE_STEWARD_WORKER_LEASE_ID` | Shared lease id for the merge queue worker group. | `merge-queue` |
| `MERGE_STEWARD_WORKER_LEASE_TTL_MS` | Lease expiry window used for worker failover. | `30000` |
| `MERGE_STEWARD_WORKER_LEASE_HEARTBEAT_INTERVAL_MS` | Heartbeat interval while an iteration is running. | `10000` |
| `MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS` | Age threshold for recovering orphaned `running` or `building_integration` queue items before claiming more work. Must be at least the lease TTL. | `120000` |
| `MAX_LOW_RISK_CHANGED_LINES` | Policy threshold override. | `120` |
| `MAX_MEDIUM_RISK_CHANGED_LINES` | Policy threshold override. | `400` |
| `STALE_AFTER_TARGET_COMMITS` | Policy freshness override. | `20` |
| `MAX_RETRIES` | Queue retry limit override. | `2` |
| `MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT` | Requires every agent PR to include a valid agent workflow receipt. | `false` |
| `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT` | Requires agent workflow receipts to carry a steward-verifiable signature. | `false` |
| `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV` | Env var name containing the HMAC secret used to verify Eliza Cloud run receipts. | `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET` |
| `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET` | HMAC secret value used when the default receipt secret env is selected. Store it outside Git. | unset |
| `MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE` | Requires agent PR source branches to start with the submitting agent namespace before queue scheduling or live merge execution. | `false` |
| `MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX` | Prefix used to build agent branch namespaces like `agent/<agent-id>/...`. | `agent` |
| `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY` | Requires agent PR owners to appear in the allowed-agent registry before queue scheduling or live merge execution. | `false` |
| `MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` | Comma-separated bootstrap allowed Eliza agent ids. The effective count also includes persisted active `/api/agent-identities` rows; values are not exposed. | unset |

Store the variables named by `FORGEJO_TOKEN_ENV` and
`FORGEJO_WEBHOOK_SECRET_ENV` in the deployment secret manager. Production live
integration also requires the secret named by
`MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV` when verified agent run receipts
are enabled. The image and CI workflow do not require those secret values.

Set `MERGE_STEWARD_DEPLOYMENT_MODE=production` for any externally reachable
service. Production mode fails startup when critical safety controls are
missing: webhook secret, Postgres runtime store, control API auth, webhook
delivery-ID replay protection, and the Forgejo event gate with at least one
allowed repository. `local` mode stays permissive for private demos; `staging`
mode logs warnings for staging-only choices such as JSON queue storage.
Deploy scripts can run the same check without starting the server:

```sh
npm run preflight --prefix services/merge-steward
```

After the service is reachable, run the deployment doctor before routing
traffic or approving a live merge-queue drill:

```sh
MERGE_STEWARD_DOCTOR_TOKEN="$MERGE_STEWARD_API_TOKEN" \
npm run doctor --prefix services/merge-steward -- https://git.staging.example.invalid/steward
```

The doctor checks `/health`, `/ready`, discovery, OpenAPI, runtime preflight
state, worker-lease readiness when the worker is enabled, required `/metrics`
series, and the workflow, GitHub parity, production readiness, project board,
Eliza Work items, cycles, modules, progress, views, dashboard, intake, merge
queue, release readiness, repository protection, agent insights, agent
capacity, agent performance, agent routing, bootstrap, cockpit, action plan,
submission gate, work preflight, work reservation, CI failure analysis,
validation plan, PR brief, review assignment, patch conflict prediction,
release notes, and agent inbox product APIs. It
exits nonzero and returns structured JSON when any required check fails.

Also store the variable named by `MERGE_STEWARD_API_TOKEN_ENV` as a private
secret and set `MERGE_STEWARD_API_AUTH_REQUIRED=true` for any deployment where
the service is reachable beyond localhost. For private staging, callers can
send `Authorization: Bearer <token>` to the queue, comment, plan, and execution
endpoints. When `MERGE_STEWARD_OIDC_ENABLED=true`, the same bearer slot also
accepts Eliza Cloud JWTs with the configured issuer, audience, and optional
role/group allowlists. OIDC agent tokens are bound to `eliza_agent_id` /
`eliza_agent_ids` for claim mutation routes, and human actor fields such as
approval decisions and policy overrides are stamped from the authenticated
actor alias. Static API tokens and OIDC identities with
`MERGE_STEWARD_OIDC_ADMIN_ROLES` or `MERGE_STEWARD_OIDC_ADMIN_GROUPS` remain
privileged control-plane credentials.

For private single-process staging, mount a writable volume at `/state` and set
`QUEUE_STORE_PATH=/state/queue.json`. That file contains queue observations and
webhook event summaries, so treat it as private runtime state. The JSON store is
suitable for one private staging steward only. It persists
claim ownership, attempt count, `running`/`merged`/`failed` state, approval
requests/decisions, steward runs/nodes/attempts/events, human requests,
external signals, agent work claims, and refuses more than one running item per
repository/target lane, but it is not a distributed lock.

## Production Database

The Postgres production schema lives at:

```text
services/merge-steward/db/migrations/001_steward_runtime.sql
services/merge-steward/db/migrations/002_postgres_store_payloads.sql
services/merge-steward/db/migrations/003_agent_claims.sql
services/merge-steward/db/migrations/004_worker_leases.sql
services/merge-steward/db/migrations/005_repository_policies.sql
services/merge-steward/db/migrations/006_agent_identity_registry.sql
services/merge-steward/db/migrations/007_work_items.sql
services/merge-steward/db/migrations/008_work_cycles_modules.sql
services/merge-steward/db/migrations/009_work_views.sql
services/merge-steward/db/migrations/010_work_pages.sql
```

These migrations create tables for queue items, runs, run nodes, worker
attempts, sequenced run events, approvals, human requests, external signals,
webhook deliveries, generic event audit, repo policy, agent work claims,
worker leases, steward-owned repository policies, registered agent identities,
durable work items, work cycles/modules, saved work views, and work pages.
The second migration adds payload JSON columns so indexed SQL columns and full
agent/runtime metadata round-trip together. The third migration records
repo/resource work leases with owner, TTL, renew, and release fields so agents
can coordinate before creating overlapping work. The fourth migration records
merge worker leases so multiple steward replicas can run while only the active
lease holder auto-claims merge work. Later migrations add strict policy state,
agent identity registry rows, and Eliza Work planning tables for views and
pages.

Set `DATABASE_URL` to make the Node service use `PostgresQueueStore`.
`DATABASE_URL` wins over `QUEUE_STORE_PATH`. The adapter uses transactions and
row locks for queue claims, stale attempt recovery, and worker lease ownership.
The partial unique lane index keeps one running queue item per
repository/target branch. Apply migrations before booting the service:

```sh
DATABASE_URL=postgres://... npm run migrate --prefix services/merge-steward
```

The migration runner records applied files in `steward_schema_migrations` and
rejects checksum drift for already-applied migrations.

## HTTP Surface

The service exposes a private JSON API:

```text
GET  /health
GET  /ready
GET  /metrics
GET  /api/workflows
GET  /api/github-parity
GET  /api/production-readiness
GET  /api/project-board?repo=owner%2Frepo
GET  /api/work-items?repo=owner%2Frepo
POST /api/work-items
POST /api/work-items/transition
GET  /api/work-cycles?repo=owner%2Frepo
POST /api/work-cycles
GET  /api/work-modules?repo=owner%2Frepo
POST /api/work-modules
GET  /api/work-progress?repo=owner%2Frepo
GET  /api/work-views?repo=owner%2Frepo
POST /api/work-views
GET  /api/work-pages?repo=owner%2Frepo
GET  /api/work-pages/item?id=page%3Aowner%2Frepo%3Awork%3Aexample%3Aagent_plan
POST /api/work-pages
POST /api/work-pages/transition
GET  /api/fleet-coordination?repo=owner%2Frepo&ownerAgentId=agent-one
GET  /api/work-context?repo=owner%2Frepo&ownerAgentId=agent-one
GET  /api/work-dashboard?repo=owner%2Frepo
GET  /api/work-intake?repo=owner%2Frepo
POST /api/work-intake/apply
GET  /api/merge-queue?repo=owner%2Frepo
GET  /api/merge-train?repo=owner%2Frepo
GET  /api/queue/item/action-plan?id=owner%2Frepo%2312&ownerAgentId=agent-one
GET  /api/search?q=failed+typecheck&repo=owner%2Frepo
POST /api/search
POST /api/queue/simulate
GET  /api/release-readiness?repo=owner%2Frepo
GET  /api/repository-protection?repo=owner%2Frepo
GET  /api/agent-insights?repo=owner%2Frepo
GET  /api/agents?repo=owner%2Frepo
GET  /api/agent-identities
GET  /api/agent-performance?repo=owner%2Frepo
GET  /api/agent-routing?repo=owner%2Frepo
GET  /api/agents/:agentId/bootstrap?repo=owner%2Frepo
GET  /api/agents/:agentId/cockpit?repo=owner%2Frepo
POST /api/agents/:agentId/action-plan
POST /api/agents/:agentId/submission-gate
POST /api/ci/validation-plan
POST /api/agents/:agentId/work-preflight
POST /api/agents/:agentId/work-reservation
POST /api/ci/failure-analysis
POST /api/pr/brief
POST /api/review/assignment
POST /api/patch/conflict-prediction
GET  /api/releases/notes?repo=owner%2Frepo
GET  /api/agents/:agentId/inbox?repo=owner%2Frepo
GET  /api/coordination
GET  /api/approvals
POST /api/approvals
POST /api/approvals/decide
GET  /api/human-requests
GET  /api/human-requests/item?id=human%3Arun-one%3Areview%3A0
POST /api/human-requests
POST /api/human-requests/respond
GET  /api/signals
POST /api/signals
POST /api/signals/consume
GET  /api/claims
GET  /api/claims/item?id=claim%3Aowner%2Frepo%3Apath%3Asrc%2Fcore.ts
POST /api/claims
POST /api/claims/renew
POST /api/claims/release
POST /api/claims/transfer
GET  /api/repo-policies
GET  /api/repo-policies/item?repo=owner%2Frepo
POST /api/repo-policies
GET  /api/runs
POST /api/runs
GET  /api/runs/:id
GET  /api/runs/:id/run-state
GET  /api/runs/:id/nodes
POST /api/runs/:id/nodes
GET  /api/runs/:id/attempts
POST /api/runs/:id/attempts
GET  /api/runs/:id/events?afterSeq=1
POST /api/runs/:id/events
GET  /api/attempts/item?id=attempt%3Arun-one%3Achecks%3A1
POST /api/attempts/heartbeat
POST /api/attempts/finish
POST /api/attempts/fail
POST /api/attempts/cancel
POST /api/attempts/claim-stale
GET  /api/queue
GET  /api/queue/item?id=owner%2Frepo%2312
GET  /api/queue/item/run-state?id=owner%2Frepo%2312
POST /api/queue/claim
POST /api/queue/item/finish
POST /api/queue/item/fail
POST /api/queue/item/override
POST /api/queue/item/override/clear
POST /api/queue/evaluate
POST /api/queue/schedule
GET  /api/queue/integration-plan
POST /api/queue/integration-plan
POST /api/queue/integration-execution
POST /api/queue/run-once
POST /api/comments/render
POST /api/webhooks/forgejo
```

`GET /health` is intentionally shallow and should be used as a liveness probe.
`GET /ready` performs a real queue-store read and reports store backend,
control API auth readiness, webhook secret presence, deployment mode, runtime
preflight errors/warnings, enabled runtime modes, and worker lease readiness
when the worker is enabled. It returns HTTP 503 when the store is unavailable,
worker lease storage is unavailable, required control API auth is not
configured, or the active deployment mode fails runtime preflight.

`GET /metrics` emits low-cardinality Prometheus text metrics for readiness,
queue state, scheduled and running queue depth, runs, attempts, agent claims,
repo policies, worker enablement, and worker lease ownership/expiry. Production
preflight fails if metrics are enabled without
`MERGE_STEWARD_METRICS_AUTH_REQUIRED=true`.

`POST /api/webhooks/forgejo` expects the raw Forgejo webhook body and a valid
HMAC-SHA256 signature header. The steward accepts pull request webhooks as queue
observations and uses status or workflow events to enrich existing queue entries
by head SHA.
Delivery IDs are recorded before queue mutation. A repeated delivery ID returns
an accepted duplicate response without reapplying queue state or feedback.
Set `MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID=true` in staging and production.

When `MERGE_STEWARD_EVENT_GATE_ENABLED=true`, signed webhooks pass through a
pure event gate before queue mutation. The gate checks configured repositories,
normalized event kind, PR openness, fork policy, and trusted actors for comment
commands. Blocked deliveries are still recorded for audit with
`{ gated: true, reason }`, but they do not create or update queue items.

All other `/api/*` endpoints should be treated as control endpoints. When
`MERGE_STEWARD_API_AUTH_REQUIRED=true` or `MERGE_STEWARD_OIDC_ENABLED=true`,
they require either the static bearer token configured through
`MERGE_STEWARD_API_TOKEN_ENV` or a valid Eliza Cloud JWT. Requests larger than
`MERGE_STEWARD_MAX_BODY_BYTES` are rejected with HTTP 413 before the body is
fully buffered.

`GET /api/queue/item/run-state` returns the computed state for UI surfaces,
including normalized states such as `running`, `waiting-approval`,
`waiting-event`, `stale`, `failed`, `cancelled`, and `succeeded`, plus
structured `blocked` or `unhealthy` reason payloads when available.

`GET /api/coordination` returns a dashboard-ready summary of queue depth, live
lanes, lane claim owner, max attempt count, current blockers, active and stale
agent claims, run states, agent ownership rows, hot paths, and hot packages. It
is the first API surface intended for an Eliza Cloud Git pane that needs one
cheap call instead of manually joining queue, claim, and run lists.

`POST /api/queue/claim` computes the current policy-ready schedule from
persisted state, marks the first available item `running`, records `workerId`,
and increments `attemptCount`. The same policy evidence blocks stacked PR
children until their parent dependencies have landed, including explicit
dependency metadata and target branches that point at another queued PR source
branch. `POST /api/queue/item/finish` marks a claimed item terminal, usually
`merged` or `cancelled`; `POST /api/queue/item/fail` records a failed queue
attempt and error text. Terminal and running items are not scheduled again.
`POST /api/queue/evaluate` is read-only but still merges the submitted item with
the persisted queue context before policy evaluation, so repo policy and stacked
PR parent/child evidence are consistent with the scheduler and worker claim
paths.

`POST /api/queue/item/override` applies an audited human policy override to a
queue item. The request must include `id`, `approvedBy`, and `reason`, and may
include `blockers` to scope the exception. Overrides are intentionally narrow:
they can clear human-reviewable policy blockers such as missing agent plan,
validation, run receipt, sensitive path approval, high conflict risk, or unknown
agent quarantine, but they never bypass failed or missing checks, stale head
state, closed/merged/draft/unmergeable PR state, disabled repository queues, or
other hard merge-safety blockers. `POST /api/queue/item/override/clear` records
the human and reason that removed the exception. Both endpoints write queue
audit events and append run events when a steward run is linked to the item.

`POST /api/approvals` creates or updates a staging approval record. Use
`queueItemId` or `runId`, optional `nodeId`, `request`, and `allowedActors`
fields. `GET /api/approvals?status=requested` lists approval inbox items, and
`POST /api/approvals/decide` records an approval or denial with `id`,
`approved`, `decidedBy`, and optional `note`. Run-scoped approval requests move
the run/node into `waiting_approval`; approving resumes the run, denying marks
it failed, and both request and decision append run events. These records are
the staging precursor to the production `steward_approvals` table described in
`docs/steward-runtime-model.md`.

The `/api/runs` endpoints are the staging precursor to the durable steward run
tables. A run represents one PR landing attempt or attached agent workflow;
nodes represent gates such as policy, approval, integration checks, and merge;
events form an append-only timeline. `GET /api/runs/:id/run-state` returns the
same computed state shape intended for Eliza Cloud dashboards.
Run events are assigned per-run `seq` numbers so dashboards and agents can poll
with `GET /api/runs/:id/events?afterSeq=<lastSeenSeq>` before SSE/WebSocket
streaming exists.

Live integration execution can now perform the final Forgejo pull request merge
through the same Forgejo client used for status reads. It still requires
`MERGE_STEWARD_INTEGRATION_ENABLED=true`,
`MERGE_STEWARD_INTEGRATION_DRY_RUN=false`, a request body with `confirm: true`,
non-empty required checks unless explicitly allowed, and successful head/base
revalidation immediately before merge.

Integration planning is policy-aware. Global batching or repo policy
`queueMode: batched` can select more than one ready PR, but only for low-risk,
low-conflict items in the same repo/target lane with disjoint changed
files/packages. Unsafe candidates are returned in `skippedItems` with reasons
such as `batch_impact_overlap`, `different_queue_lane`, `item_not_batch_safe`,
or `max_batch_size`.

Live execution handles multi-PR plans as a sequential merge train. Each item
gets an integration branch, required checks, final head/base revalidation, and
then a Forgejo merge before the next item starts. Later train items are blocked
with `merge_train_predecessor_failed` if an earlier item fails, so the steward
does not merge a PR that was not tested after earlier queued changes landed.

`POST /api/queue/run-once` is the durable worker endpoint for the merge queue.
It refuses to claim work unless live integration is enabled and the request
includes `confirm: true`. When active, it claims one policy-ready item or one
safe same-lane merge train, creates steward runs, writes queue-claim and
integration nodes, records attempts, executes the integration plan, and then
marks each run plus queue item succeeded, failed, or requeued when a predecessor
blocks the train.

The long-running worker loop uses the same durable path. Enable it only after
live integration has been validated:

```sh
MERGE_STEWARD_WORKER_ENABLED=true \
MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true \
npm run worker --prefix services/merge-steward
```

Runtime preflight fails when the worker is enabled without live integration and
explicit worker confirmation. In production, the durable worker lease is also
required. Multiple worker-enabled steward replicas may run against the same
Postgres database, but only the active `MERGE_STEWARD_WORKER_LEASE_ID` holder
auto-claims merge work; the TTL controls failover after a worker stops
heartbeating. Postgres claims use transaction-scoped lane locks, so one worker
can claim a same-lane merge train while other workers are prevented from
claiming that lane until the active train leaves `running` or
`building_integration`. On each lease-held iteration, the worker recovers stale
active queue items older than `MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS`, marks
their orphaned run/attempt records failed, and requeues the PR for a fresh
policy/enrichment pass.

`/api/runs/:id/attempts` creates and lists worker attempts for a node. Attempt
workers heartbeat through `/api/attempts/heartbeat`, record terminal state
through finish/fail/cancel endpoints, and can recover stale leases through
`/api/attempts/claim-stale`. The Postgres store performs stale recovery inside
a row-locked transaction.

`/api/human-requests` stores structured maintainer prompts such as `ask`,
`confirm`, `select`, and `json`. Requests can be listed by status or run, then
answered through `/api/human-requests/respond`. `/api/signals` stores correlated
external wakeups for runs waiting on checks, webhooks, agent receipts, or human
answers. When a signal matches a `waiting_event` run or node correlation key,
the staging steward marks the node succeeded, moves the run back to `running`,
appends a run event, and consumes the signal. `/api/signals/consume` remains
available for manual worker acknowledgement.

`/api/claims` stores agent work leases for resources such as issues, pull
requests, branches, paths, packages, tasks, and queue items. `POST /api/claims`
creates or renews a lease for the owning agent and returns HTTP 409 when another
agent still owns an active unexpired lease for the same repo/resource, or when a
caller reuses a custom claim id that already belongs to another resource. Agents
can extend TTLs through `/api/claims/renew` and release work through
`/api/claims/release`. The JSON store deduplicates leases by repo/resource for
private single-process staging; the Postgres store enforces the same invariant
with a unique index and row lock.

`/api/repo-policies` stores the per-repository merge policy. Use it to set
`queueMode` (`disabled`, `serialized`, or `batched`), `protectedBranches`,
`requiredChecks`, `trustedActors`, `allowForks`, and optional structured
`policy` metadata. The JSON store persists these policies locally; the Postgres
store maps them to `steward_repo_policies`. The steward applies repo policies
before evaluation, scheduling, queue claims, integration planning, and webhook
queue item updates. `disabled` repos are blocked with `repo_queue_disabled`,
repo required checks are merged onto queue items, trusted actors can mark known
agents, and configured protected branches satisfy the branch-protection gate.
`GET /api/repository-protection?repo=owner%2Frepo&requireLive=true` compares
these durable policy settings with live Forgejo branch-protection evidence and
should pass before live agent merges are enabled. Use
`GET /api/release-readiness?repo=owner%2Frepo&requireRepositoryProtection=true&requireLiveProtection=true`
to make merge-window checks fail closed on missing or incomplete protection
evidence.

Feedback mirroring is safe by default:

- `FORGEJO_FEEDBACK_ENABLED=false` means no Forgejo mutations are attempted.
- `FORGEJO_FEEDBACK_DRY_RUN=true` returns planned label/comment operations in
  webhook responses without applying them.
- Comment-origin events and events created by `FORGEJO_STEWARD_USERNAME` are
  skipped to avoid feedback loops.
- Live mode uses additive label APIs and removes only steward-owned labels such
  as `queue:*`, `risk:*`, `agent-owner:*`, `agent:claimed`,
  `agent:needs-human`, `agent:stale`, `agent:stale-claim`, and
  `agent-submit:*`.
- Live mode checks existing issue comments before posting the same queue comment
  again.

Read-only enrichment is also disabled by default. When
`FORGEJO_ENRICHMENT_ENABLED=true`, the steward uses the Forgejo API to fetch:

```text
GET /repos/{owner}/{repo}/pulls/{number}
GET /repos/{owner}/{repo}/pulls/{number}/files
GET /repos/{owner}/{repo}/pulls/{number}/reviews
GET /repos/{owner}/{repo}/commits/{sha}/status
GET /repos/{owner}/{repo}/commits/{sha}/statuses
```

Enrichment failures are non-fatal. The webhook-derived queue item is preserved,
and stale head-SHA data is blocked rather than allowed to reuse old green
statuses.

The merge policy also blocks pull requests that are already merged, closed,
draft, or explicitly unmergeable. Those lifecycle facts are read from webhooks
and refreshed through enrichment before live execution when enrichment is
enabled.

For agent-authored PRs, the default policy also requires explicit plan and
validation touchpoints in the title/body. Add markdown sections such as
`## Plan` and `## Validation` so humans can review the intent and the expected
backpressure before the steward queues the change.

Agent-authored PRs may also include an agent workflow receipt. The steward reads
sections headed `Agent Run` or `Eliza Run`:

```markdown
## Agent Run
runId: run_123
state: succeeded
failedChildren: 0
url: https://cloud.eliza.example/runs/run_123
updatedAt: 2026-07-06T00:00:00.000Z
signature: sha256=<base64url-hmac>
```

Receipts with `waiting-approval`, stale/orphaned/recovering states, unhealthy
heartbeat metadata, failed terminal states, or `failedChildren > 0` block the PR
from entering the queue. Set `MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT=true` only
after the agent platform is reliably writing these receipts. To close spoofing
gaps, set `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` and configure
`MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV` to point at a private shared secret.
Eliza Cloud should sign the stable JSON payload produced from `runId`, `state`,
`failedChildren`, `failedChildKeys`, `url`, `updatedAt`, `blocked`, and
`unhealthy` with HMAC-SHA256 and write it as `sha256=<base64url digest>`.
For production live merges, also set
`MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` and populate
`MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` from Eliza Cloud's allowed agent ids so
the steward does not trust PR-supplied `agentKnown` facts.

Integration planning is non-mutating. The planner selects ready queue items,
names integration branches such as `eliza-queue/develop/elizaos-eliza-pr-12`,
and returns the action sequence the guarded executor can perform.

The execution endpoint is present but guarded. Live execution requires all of:

- `MERGE_STEWARD_INTEGRATION_ENABLED=true`
- `MERGE_STEWARD_INTEGRATION_DRY_RUN=false`
- request body contains `confirm: true`
- every plan has required checks unless
  `MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS=true`
- an injected integration executor client implements every planned action

When execution is live, request-body `items` are ignored. The steward plans only
from persisted queue state. If read-only enrichment is enabled, each persisted
item is refreshed from Forgejo before planning, and fresh check results replace
stored check results. If the refresh is unavailable, the item is blocked rather
than executed on stale facts. Disabled and dry-run execution still accept
request-body items for local planning and test workflows.

Before the final merge action, the executor re-reads the pull request when the
client supports `getPullRequest` and rejects stale head SHA, closed PRs, merged
PRs, or changed target branches.

The bundled `local-git` adapter can prepare a local worktree, reset an
integration branch from the target branch, merge the PR source branch into it,
and optionally push that integration branch when
`MERGE_STEWARD_INTEGRATION_PUSH_BRANCH=true`. It also performs the final
Forgejo pull request merge through the configured Forgejo client after required
checks and head/base revalidation pass.

The local adapter does implement the check-wait action through Forgejo commit
statuses. It reads combined status first, falls back to commit statuses, requires
all planned checks to be green, and treats missing/empty required checks as
blocked unless explicitly allowed. Executor output includes per-check provenance
such as target URLs, status ids, descriptions, and Actions run ids when Forgejo
status metadata provides them.

## Local Validation

Run package validation without starting the service:

```sh
npm run check --prefix services/merge-steward
npm test --prefix services/merge-steward
DATABASE_URL=postgres://... npm run migrate --prefix services/merge-steward
docker build -f services/merge-steward/Dockerfile -t merge-steward:local .
```
