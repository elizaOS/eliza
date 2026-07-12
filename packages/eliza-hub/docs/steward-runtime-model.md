# Steward Runtime Model

This is the target data model for turning the current Merge Steward prototype
into an Eliza Cloud-backed coordination service for durable agent workflow and
merge-queue state.

The Postgres migrations for this model live in
`services/merge-steward/db/migrations/`. The staging service can use the JSON
store for a single private process or `PostgresQueueStore` when `DATABASE_URL`
is set.

## Runtime Objects

### `steward_runs`

One run represents a PR landing attempt or an agent workflow attached to a PR.

| Field | Purpose |
| --- | --- |
| `id` | Stable run id. |
| `repo` | Forge repo full name, for example `elizaos/eliza`. |
| `queue_item_id` | Queue item id, for example `elizaos/eliza#123`. |
| `pull_request_id` | Forgejo pull request number. |
| `source_branch` | Candidate branch. |
| `target_branch` | Base branch. |
| `owner_kind` | `human`, `agent`, `service`. |
| `owner_id` | Eliza user/agent/service id. |
| `status` | Raw persisted status: `running`, `waiting_approval`, `waiting_event`, `waiting_timer`, `paused`, `finished`, `failed`, `cancelled`. |
| `runtime_owner_id` | Worker/agent currently driving the run. |
| `heartbeat_at` | Last runtime heartbeat. |
| `started_at` | First start time. |
| `finished_at` | Terminal time. |
| `summary_json` | Compact run summary for long-running context refresh. |

### `steward_run_nodes`

Nodes make a landing attempt inspectable as a sequence of gates.

Expected node ids for a merge run:

```text
observe_pr
policy
agent_receipt
ai_review
human_approval
claim_queue
prepare_integration_branch
run_integration_checks
merge_pull_request
post_receipt
```

Store node status, attempts, start/finish timestamps, agent/model identity, and
structured output. The UI should show node state rather than forcing users to
read raw comments.

### `steward_attempts`

Attempts track retries and live heartbeats for long-running agent work.

| Field | Purpose |
| --- | --- |
| `run_id` | Parent run. |
| `node_id` | Parent node. |
| `attempt` | 1-based attempt number. |
| `status` | `running`, `succeeded`, `failed`, `cancelled`. |
| `agent_id` | Agent or worker that executed the attempt. |
| `heartbeat_at` | Last attempt heartbeat. |
| `error_json` | Structured failure payload. |
| `output_json` | Validated node output. |

### `steward_events`

Append-only audit log for run, node, approval, webhook, and merge actions.

Events should be small JSON records with:

- `type`
- `run_id`
- `queue_item_id`
- `actor_kind`
- `actor_id`
- `payload_json`
- `created_at`

This is what powers timelines, debugging, replay, and postmortems.

### `steward_approvals`

Approvals must be first-class records, not only labels.

| Field | Purpose |
| --- | --- |
| `run_id` | Parent run. |
| `node_id` | Approval node. |
| `status` | `requested`, `approved`, `denied`, `expired`. |
| `request_json` | What is being approved, including risk and diff summary. |
| `allowed_actors_json` | Users, teams, or roles allowed to decide. |
| `decision_json` | Decision payload and optional note. |
| `requested_by` | Agent/service requesting approval. |
| `decided_by` | Human/service that decided. |
| `requested_at` | Request time. |
| `decided_at` | Decision time. |

Forgejo labels and comments should mirror this state. Eliza Steward should keep
the database authoritative.

### `steward_human_requests`

Agents need a structured way to ask maintainers for information without abusing
PR comments.

Supported request kinds:

- `ask`: free-text answer
- `confirm`: yes/no
- `select`: choose one option
- `json`: provide a typed payload

Use this for migration strategy choices, missing credentials, release timing,
or high-risk merge confirmation.

### `steward_signals`

Signals unblock runs waiting on external events.

Examples:

- Forgejo Actions check completed.
- Agent run receipt updated.
- Human request answered.
- Branch rebased.
- Required deployment window opened.

Signals should include a correlation key so one noisy webhook cannot wake an
unrelated run.

### `steward_agent_claims`

Agent claims are repo/resource leases that coordinate many agents before they
create overlapping branches or PRs.

| Field | Purpose |
| --- | --- |
| `repo` | Forge repo full name. |
| `resource_kind` | `issue`, `pull_request`, `branch`, `path`, `package`, `task`, or `queue_item`. |
| `resource_id` | Stable id within the repo/resource kind. |
| `owner_agent_id` | Agent that owns the lease. |
| `task_id` | Optional Eliza task id. |
| `run_id` | Optional steward or agent run id. |
| `branch` | Optional branch created for the work. |
| `paths_json` | Optional file/package paths covered by the claim. |
| `status` | `active`, `released`, `expired`, or `cancelled`. |
| `claimed_at` / `renewed_at` / `expires_at` | Lease timing fields. |
| `released_at` / `release_reason` | Release audit fields. |

The production invariant is one claim row per `(repo, resource_kind,
resource_id)`. Active unexpired claims block other agents; the same agent can
renew or reclaim the row.

### `steward_work_items`, `steward_work_cycles`, `steward_work_modules`, and `steward_work_views`

Eliza Work records are steward-owned planning objects that sit beside Forgejo
issues and PRs. Work items represent durable agent intake; cycles represent
time-boxed or release-window work; modules represent owned repo areas such as a
package, path group, or product surface. Work views represent durable saved
filters, layouts, and dashboard definitions that Eliza Cloud and agents can
reuse instead of rebuilding query parameters.

| Field | Purpose |
| --- | --- |
| `repo` | Forge repo full name. |
| `state` | Work item, cycle, module, page, or saved view lifecycle state. |
| `owner_agent_id` | Agent currently responsible for the item, cycle, module, or page. |
| `cycle_id` / `module_id` | Work item links to cycle and module planning scopes. |
| `paths_json` / `packages_json` | File and package scope for routing and conflict checks. |
| `metadata_json` | Extensible planning metadata and transition history. |
| `payload_json` | Full normalized steward object for forward-compatible reads. |

Progress snapshots are computed from these rows and exposed through
`GET /api/work-progress`; dashboard snapshots are computed from saved views and
active work pages, then exposed through `GET /api/work-dashboard`.
`GET/POST /api/work-pages` stores durable Markdown context for agent plans,
runbooks, release notes, decisions, specs, and notes linked to work items,
cycles, modules, tasks, issues, or PRs. `GET /api/work-intake` computes a
queue-to-work create/update/transition preview, and
`POST /api/work-intake/apply` persists selected actions only after explicit
confirmation. Progress, dashboards, and intake previews are computed surfaces,
not separate durable counters.

### `steward_worker_leases`

Worker leases coordinate steward replicas that are allowed to auto-claim merge
work.

| Field | Purpose |
| --- | --- |
| `id` | Shared lease id such as `merge-queue`. |
| `owner_id` | Worker process identity that currently owns the lease. |
| `status` | `active`, `released`, `expired`, or `cancelled`. |
| `acquired_at` / `renewed_at` / `expires_at` | Lease timing and failover fields. |
| `released_at` / `release_reason` | Graceful release audit fields. |
| `metadata_json` | Optional deployment or worker-group metadata. |

The production invariant is one active unexpired owner per lease id. A worker
must hold the lease before it calls the durable merge `run-once` path. Other
worker replicas idle until the lease is released or expires.

### `steward_webhook_deliveries`

Webhook delivery ids should stay separate from queue state.

Store:

- delivery id
- provider: `forgejo`, `github`, `eliza_cloud`
- event name
- repo
- pull request id when present
- payload hash
- first seen timestamp
- processing status

The current JSON store already suppresses duplicate deliveries for staging.
Production should do this with a unique index on `(provider, delivery_id)`.

## Computed Run State

All UI and API surfaces should answer "what is this PR/run doing?" from one
computed view:

```json
{
  "runId": "run_123",
  "state": "waiting-approval",
  "blocked": {
    "kind": "approval",
    "nodeId": "human_approval",
    "requestedAt": "2026-07-06T00:00:00.000Z"
  },
  "unhealthy": null,
  "computedAt": "2026-07-06T00:01:00.000Z"
}
```

States:

```text
running
waiting-approval
waiting-event
waiting-timer
paused
recovering
stale
orphaned
failed
cancelled
succeeded
unknown
```

Rules:

- Do not infer from comments, labels, or missing events.
- `waiting-approval` means a human must decide an approval record.
- `waiting-event` means a correlated external signal is required.
- `stale` means a runtime heartbeat expired but recovery is possible.
- `orphaned` means no runtime owner can currently resume it.
- `unknown` is a telemetry gap, not a missing run.

## Control APIs

Initial Eliza Cloud-facing API surface:

```text
GET  /api/runs/:id
GET  /api/runs/:id/events
GET  /ready
GET  /api/workflows
GET  /api/github-parity
GET  /api/production-readiness
GET  /api/production-cutover
GET  /api/production-evidence-template
GET  /api/project-board?repo=owner%2Frepo
GET  /api/work-items?repo=owner%2Frepo
GET  /api/work-items/item?id=owner%2Frepo%3Atask%3Aexample
POST /api/work-items
POST /api/work-items/transition
GET  /api/work-cycles?repo=owner%2Frepo
POST /api/work-cycles
GET  /api/work-modules?repo=owner%2Frepo
POST /api/work-modules
GET  /api/work-progress?repo=owner%2Frepo
GET  /api/work-views?repo=owner%2Frepo
POST /api/work-views
GET  /api/work-views/evaluate?id=view%3Aowner%2Frepo%3Adocs
POST /api/work-views/evaluate
GET  /api/work-pages?repo=owner%2Frepo
GET  /api/work-pages/item?id=page%3Aowner%2Frepo%3Awork%3Aexample%3Aagent_plan
POST /api/work-pages
POST /api/work-pages/transition
GET  /api/fleet-coordination?repo=owner%2Frepo&ownerAgentId=agent-one
GET  /api/work-context?repo=owner%2Frepo&ownerAgentId=agent-one
GET  /api/work-dashboard?repo=owner%2Frepo
GET  /api/work-intake?repo=owner%2Frepo
POST /api/work-intake/apply
GET  /api/merge-train?repo=owner%2Frepo
GET  /api/merge-queue?repo=owner%2Frepo
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
GET  /api/queue/item/action-plan?id=owner%2Frepo%2312&ownerAgentId=agent-one
POST /api/agents/:agentId/action-plan
POST /api/agents/:agentId/submission-gate
POST /api/agents/:agentId/work-preflight
POST /api/agents/:agentId/work-reservation
POST /api/ci/failure-analysis
POST /api/ci/validation-plan
POST /api/pr/brief
POST /api/review/assignment
POST /api/patch/conflict-prediction
GET  /api/agents/:agentId/inbox?repo=owner%2Frepo
POST /api/agents/:agentId/claim-assignment
POST /api/agents/:agentId/claim-next
GET  /api/coordination
POST /api/claims/transfer
GET  /api/queue/item?id=owner%2Frepo%2312
GET  /api/queue/item/run-state?id=owner%2Frepo%2312
POST /api/queue/claim
POST /api/queue/item/finish
POST /api/queue/item/fail
POST /api/queue/item/override
POST /api/queue/item/override/clear
POST /api/queue/run-once
GET  /api/claims
GET  /api/claims/item?id=claim%3Aowner%2Frepo%3Apath%3Asrc%2Fcore.ts
POST /api/claims
POST /api/claims/renew
POST /api/claims/release
GET  /api/repo-policies
GET  /api/repo-policies/item?repo=owner%2Frepo
POST /api/repo-policies
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
```

These are control endpoints. They require Eliza Cloud identity or the
temporary bearer-token guard used by the current staging service.
The machine-readable OpenAPI 3.1 contract for this surface is
served by the steward at `GET /openapi.json` and stored at
`services/merge-steward/openapi.json`. Agent and Eliza Cloud bootstrap clients
can discover the contract, auth mode, and agent-native capabilities through
`GET /.well-known/eliza-hub.json`.
The discovery manifest also includes `clientHints.mergeExecution`, a compact
non-secret summary of integration enabled/dry-run state, executor type,
batching, branch-push posture, worker confirmation, and durable lease posture.
It intentionally exposes only booleans and safe names, and it always marks live
agent merges as production-cutover and private-evidence gated.

The staging service also implements `GET /api/github-parity`, an explicit
GitHub/Forgejo/Eliza parity matrix for Eliza Cloud and agent clients. It marks
core Git collaboration as Forgejo-native, project boards as Eliza-computed,
merge queue behavior as Merge Steward-owned, and GitHub-only surfaces such as
native Discussions or Codespaces as unsupported instead of implying full GitHub
parity. The matrix is also a migration aid: every surface can carry maturity,
agent-fit, and non-drop-in flags, and the top-level guardrails call out runner
evidence, Projects v2 replacement, unsupported Discussions, and evidence-gated
live merges.
For cutover planning, every surface also includes `productionDisposition`,
`cutoverBlocker`, `requiredEvidence`, `requiredGateChecks`,
`cutoverReadiness`, `migrationTarget`, `targetApis`, and `nextAction`. Public
responses are evidence-free and therefore leave cutover-blocking surfaces in
`private_evidence_required`. Operators can run
`eliza-merge-steward github-parity [--strict] < eliza-hub-production-evidence.json`
to score those same surfaces against the private production gate before moving
traffic or repository source of truth. Eliza Cloud should treat
`cutoverBlocker: true` surfaces as blocked until the named private production
evidence paths and gate checks pass, and should treat `accepted_gap` surfaces as
explicit product decisions rather than missing implementation work.

The staging service also implements `GET /api/production-readiness`, a
secret-free launch checklist for Eliza Cloud, operators, and agents. It maps
each production-gate check to the private evidence block, helper command,
surface area, and next action needed before live production traffic or live
agent merges can be enabled. `GET /api/production-cutover` turns that checklist
into ordered phases, guardrails, helper commands, final verification commands,
and a `githubMigration` verdict derived from the GitHub parity matrix. Live
agent merges stay blocked unless both the production gate and
`githubMigration.cutoverReady` pass against the same private evidence bundle.
`GET /api/production-evidence-template` returns a schema-valid, non-passing
scaffold for private operator state without storing or accepting live evidence.
Private cutover rehearsals should run
`node services/merge-steward/src/cli.js production-readiness --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"`
or `production-gate --strict` locally, so artifact source re-reads and
freshness checks are included without exposing live evidence through the public
API.

The staging service also implements `GET /api/merge-train`, a read-only
agent-facing execution contract for the next selected merge train. It exposes
selected PRs, integration branches, required checks, lane blockers, dry-run or
live-execution blockers, preflight checks such as missing required checks or
active lane work, and queue-run links without mutating queue or Forgejo state.

The staging service also implements `GET /api/search` and `POST /api/search`,
the deterministic repo-context search layer for agents and Eliza Cloud. It
searches persisted steward PR, queue, claim, run, approval, human-request, and
signal state, and `POST` can include caller-supplied issue, diff, or Actions
log documents. It returns `{ search }` with ranked results, match evidence,
snippets, facets, labels, and no state mutation.

The steward also implements `GET /api/work-items`, `GET /api/work-items/item`,
`POST /api/work-items`, and `POST /api/work-items/transition` for durable
Eliza-owned agent intake. Work items record repo scope, owner agent, linked
task/issue/PR IDs, cycle/module IDs, paths, packages, labels, priority, and
workflow state while Forgejo remains the source of truth for git objects,
issues, PRs, Actions, and packages.

The steward also implements `GET/POST /api/work-cycles`,
`GET/POST /api/work-modules`, transition routes for both scopes,
`GET/POST /api/work-views`, `GET/POST /api/work-views/evaluate`,
`GET/POST /api/work-pages`,
`GET /api/work-dashboard`, `GET /api/work-context`, `GET /api/work-intake`,
`POST /api/work-intake/apply`, and `GET /api/work-progress`. Cycles, modules,
saved views, evaluated view payloads, work pages, and intake plans give agents
GitHub Projects-style planning primitives, while progress and dashboard
snapshots summarize ready, active, blocked, and done work by planning scope
without mutating state.

The `@elizaos/eliza-hub-merge-steward` package exports `MergeStewardClient`,
`createMergeStewardClient`, and `createMergeStewardClientFromEnv` for agent
runtimes and Eliza Cloud services. The client preserves reverse-proxy base
paths, fetches discovery and OpenAPI without auth, attaches bearer auth to
control API calls, and wraps failed requests in structured
`MergeStewardClientError` instances. Its named helpers cover the active
steward surface: workflow views, GitHub parity, project boards, merge queues,
queue-item action plans, stack dependency graphs, production-readiness
checklists, release-readiness gates, repository-protection audits, agent
bootstrap, cockpit, inbox, action plans, submission gates, work preflight, work
reservation, routing, capacity, agent performance, coordination summaries,
approvals, human requests, signals,
claims, repo policies, runs, attempts, queue execution, CI failure analysis,
validation planning, rendered comments, and signed Forgejo webhook submission.

The staging service now implements `GET /api/queue/item/run-state` for queue
items. It derives state from queue lifecycle, claim timestamps, and any attached
agent run receipt.

The staging service also implements audited queue policy overrides. An override
requires a human actor and reason, stores the active exception on the queue
item, writes a queue audit event, and appends run events when a run exists for
that queue item. Overrides are limited to policy/human-review blockers and do
not clear red checks, stale heads, terminal PR lifecycle states, or disabled
repo queues.

The staging service also implements `GET /api/coordination`, a compact view for
Eliza Cloud dashboards. It joins current queue items, agent claims, and steward
runs into queue lane counts, lane claim owner, max attempt count, current
blockers, active/stale claim counts, per-agent ownership rows, hot-path signals,
and hot-package signals.

The staging service also implements `GET /api/workflows`, the workflow card
view for Eliza Cloud dashboards. It joins queue items, agent claims, steward
runs, open approvals, human requests, stale claims, failed runs, next actions,
and readiness state into stable cards and inbox buckets so the UI does not need
to stitch raw control endpoints together.

The staging service also implements `GET /api/project-board`, the Eliza agent
board view for humans and agents. It groups workflow cards into stable Kanban
columns, repository lanes, owner-agent rows, and merge queue lane summaries so
Eliza Cloud can render a project board without reverse-engineering queue and
run internals. Stacked PR children with unmerged parents are marked as Waiting
cards with stack blockers and next actions, while stack roots can remain Ready.

The staging service also implements `GET /api/merge-queue`, the queue lane
summary for Eliza Cloud and agent callers. It returns lane state, blocked
items, running items, scheduled order, selected integration plans, batch
selection metadata, skip reasons, and a diagnostics object with queue health,
the next merge target, blocker groups, per-agent required actions, and
stuck/busy lanes from the same policy and planner used by the execution path.
It also reports stacked PR dependencies inferred from explicit dependency
metadata or PR target branches that point at another queued PR source branch,
including waiting parents, missing dependencies, cycles, and the next stack
item that can merge after its parents land. Those dependency facts are policy
evidence too, so scheduling, queue simulation, integration planning, and worker
claims keep stacked children out of the merge lane until their parents land.

The staging service also implements `GET /api/queue/item/action-plan`, the
read-only next-step packet for one existing PR. It composes the queue policy
decision, computed run state, workflow card, merge-train membership, stack
state, and route links into ranked actions for the owning agent without
mutating queue state.

When
`MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true`, the same queue
policy blocks agent PR scheduling, integration planning, and worker claims until
the agent has active reservations covering the PR files or packages. Production
live integration validation requires this flag before the steward can run live
merge execution. Production live integration also requires
`MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true`, which blocks agent PR
scheduling, integration planning, and worker claims until the PR, task, or
issue is linked to an active durable Eliza Work item owned by the same agent.
Production live integration also requires
`MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true`, which makes work preflight,
submission gates, queue scheduling, and live merge claims reject agent PRs whose
source branches are outside `agent/<agent-id>/...`. The final production live
merge invariant is signed agent provenance: set
`MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` and provide the secret
named by `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV` so the queue rejects
unsigned or unverifiable Eliza agent run receipts before merge execution.
Production live integration also requires an allowed-agent registry:
`MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` with a bootstrap
`MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` and/or persisted active
`/api/agent-identities` rows, so queue policy and mutating agent claim routes
reject unregistered agent ids instead of trusting PR facts.

The staging service also implements `POST /api/queue/simulate`, the read-only
enqueue preview for proposed PRs. It compares current queue state with a
`proposedItem` or `proposedItems` payload and returns policy decisions, queue
positions, selected integration plans, batch eligibility, blockers, displaced
existing work, stack dependency impact, and next actions without creating queue
rows, claims, or Forgejo side effects.

The staging service also implements `GET /api/release-readiness`, the repo
merge-window gate for Eliza Cloud. It combines merge queue blockers, selected
integration plans, stack dependency order, runtime readiness, open human
decisions, stale or failed agent work, and routing capacity into one
deterministic status with labels, required actions, and `canOpenMergeWindow` /
`canAutoMerge` booleans. Stack-blocked children get a dedicated
`stack_dependency_order` check so merge windows can tell agents to merge parent
PRs first. When runtime readiness reports live integration with
`MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=false`, release readiness
blocks the merge window and new agent routing with `strict_work_reservations`.
Add `requireRepositoryProtection=true` when a merge window must fail closed
unless the repo protection audit is production-ready.

The staging service also implements `GET /api/repository-protection`, the repo
branch-protection and required-check audit for Eliza Cloud. It compares durable
repo policy with optional live Forgejo branch-protection evidence and supports
`requireLive=true` for production cutover checks that should fail closed when
the Forgejo evidence cannot be read.

The staging service also implements `GET /api/agent-insights`, the agent-native
advisory layer over queue state. It ranks next actions, routes failed checks to
owning agents, detects overlapping PRs by path/package, identifies stale
branches and stale claims, and exposes deterministic summaries that Eliza Cloud
can render without asking every agent to recompute risk locally.

The staging service also implements `POST /api/ci/validation-plan`, the
pre-run CI budget gate for agents. It classifies proposed validation commands,
blocks broad Turbo/typecheck/build work by default, infers touched packages
from changed files, and recommends package-scoped checks before agents consume
shared runner capacity.
Agents can call the same policy locally with
`node services/merge-steward/src/cli.js validation-plan < request.json`; a
blocked plan exits non-zero so shells and orchestration code can stop before
starting expensive validation.

The staging service also implements `GET /api/agents`, the agent capacity view.
It summarizes owner-agent workload, health, active and stale claims, active
runs, open slots, unassigned PRs, and deterministic assignment suggestions so
Eliza Cloud can route new work without asking agents to poll every raw queue
record. Assignment suggestions include performance health so the steward avoids
routing fresh work to overloaded or triage agents.

The staging service also implements `GET /api/agent-performance`, the agent
performance view. It returns `{ performance }` with per-agent current load,
terminal run rates, stale claim ratios, handoff counts, risk signals, and
leader lists for dashboards and routing policy.

The staging service also implements `GET /api/agent-routing`, the compact
routing recommendation view. It returns `{ routing }` with the top assignment
recommendations, routable agents, blocked agents, and blocked reasons without
requiring clients to render the full capacity payload.

The staging service also implements `GET /api/fleet-coordination`, the
read-only fleet coordination contract. It returns `{ coordinationContract }`
with lane-tag identity rules, Work board state flow, claim protocol, evidence
rows, shared exclusive resources, active or stale shared-lever claims, and
next actions agents should read before starting work.

The staging service also implements `GET /api/work-context`, the read-only
agent resume packet. It returns `{ workContext }` for one `ownerAgentId`,
combining bootstrap identity, inbox cards, Work page/runbook links,
dashboard/progress summaries, fleet shared-lever blockers, merge queue health,
merge train preflight state, search hits, read-first links, and next actions so
an agent can resume without stitching multiple API calls together.

The staging service also implements `GET /api/agents/:agentId/bootstrap`, the
read-only agent startup snapshot. It returns `{ bootstrap }` with identity
registry status, policy hints, resolved links for agent routes, compact
inbox/routing summaries, active and stale claims, compact merge-train preflight
state, and safe next actions.

The staging service also implements `GET /api/agents/:agentId/cockpit`, the
one-call read-only agent cockpit for Eliza Cloud and agent runtimes. It returns
`{ cockpit }` with workflow operations, work context, owned focus cards,
merge-train status, ranked next actions, and route links for one owner agent.
Plain reads stay situational; work-preflight, action-plan, and submission-gate
remain the explicit proposed-work gates.

The staging service also implements `POST /api/agents/:agentId/action-plan`,
the read-only agent next-action planner. It returns `{ actionPlan }` by
composing bootstrap, inbox, routing, repo search, work preflight,
validation-budget, submission-gate, patch-conflict, and review-assignment
evidence into checks, labels, and ranked next steps before an agent starts work
or submits a PR.

The staging service also implements `POST /api/agents/:agentId/submission-gate`,
the pre-submit overload gate for agent PR creation. It returns `{ gate }` with
an allow, watch, throttle, triage, or quarantine decision based on current
capacity, failed work, stale claims, open human decisions, proposed PR
verification, per-agent open PR queue depth, recent-submission rate,
active work-reservation coverage, validation-budget scope, and change size.
Missing reservation coverage is a warning by default and a submit blocker when
the request sets `requireWorkReservation: true`.

The staging service also implements `POST /api/agents/:agentId/work-preflight`,
the pre-branch coordination gate for agent work. It returns `{ preflight }`
with active claim conflicts, overlapping open PRs, durable Work item overlaps,
hot path/package warnings, suggested claims, deterministic split plans, and
labels so agents can claim, reroute, or split work before creating another
branch. Foreign in-progress same-file Work item overlap blocks duplicate starts;
planned or package-only Work item overlap warns. `preflight.splitPlan`
groups broad or conflicted proposed work into package/path units with ready,
watch, or blocked state, suggested agent branch names, required actions, and
claim suggestions for each unit.

The staging service also implements `POST /api/agents/:agentId/work-reservation`,
the durable reservation companion to work preflight. It returns
`{ reservation }`, refuses blocked preflights, creates the suggested
path/package claims when allowed, creates or updates a durable Eliza Work item
by default, rolls back partial claims on claim or Work item failure, and
supports `dryRun: true` for planners and deployment smoke checks. Agents should
reserve work before spending runner time; submission gates and merge policy can
later require both the reservation claims and the linked Work item.

The staging service also implements `POST /api/patch/conflict-prediction`, the
read-only patch collision predictor for agents and Eliza Cloud. It accepts
proposed repo, branch, owner agent, changed files, and affected packages, then
returns `{ prediction }` with active claim conflicts, same-file and same-package
queued PR overlaps, hot path/package warnings, migration and lockfile risk,
labels, and a recommended coordination or split strategy before a branch or PR
is created.

The staging service also implements `POST /api/review/assignment`, the
read-only reviewer and owner routing layer for agents and Eliza Cloud. It
accepts a queue item or proposed repo, branch, owner agent, changed files, and
affected packages, then returns `{ assignment }` with ranked non-author
reviewer agents, excluded candidates, suggested owner agent, human maintainer
hints for sensitive paths, labels, and required actions. The scorer combines
registered agent metadata, active claims, current capacity, and performance
health so review routing is deterministic and auditable.

The staging service also implements `POST /api/ci/failure-analysis`, the
deterministic CI failure router for agents. It accepts check names, conclusions,
logs, annotations, and optional queue item context, then returns `{ analysis }`
with a primary failure category, severity, retryability, evidence lines,
suggested actions, and likely owner agent. This gives Eliza Cloud and agents a
stable first pass for noisy Actions logs before any hosted LLM summarizer is
wired in.

The staging service also implements `POST /api/pr/brief`, the deterministic PR
review brief for agents and maintainers. It accepts a queue item or
`queueItemId`, optional CI analysis, and optional validation-budget commands or
a precomputed validation plan, then returns `{ brief }` with merge decision,
risk areas, validation-budget blockers, scoped replacement commands,
work-reservation coverage, queue-depth flood blockers, commit-hygiene state,
verification gaps, reviewer hints, suggested actions, and labels. When an agent
PR supplies noisy `commits` without a `commitSummary`, the brief can require a
reviewer-facing rollup before review and label the PR `commits:needs-summary`.
When the request sets `requireWorkReservation: true`, missing reservation
coverage is treated as review-blocking evidence.

The staging service also implements `GET /api/releases/notes` and
`POST /api/releases/notes`, the deterministic release-note generator for
merged queue items. `GET` builds from persisted queue state with optional repo,
target branch, version, and time-window filters. `POST` accepts caller-supplied
merged PR facts. Both return `{ notes }` with grouped release sections, package
and agent contribution summaries, excluded-item evidence, and Markdown suitable
for a Forgejo release draft or Eliza Cloud release surface.

The staging service also implements `POST /api/agents/:agentId/claim-assignment`.
It lets an agent accept its next capacity-based assignment and persists that
assignment as a durable claim lease with suggestion metadata.

The staging service also implements `GET /api/agents/:agentId/inbox`, the
agent-facing action feed. It filters the board down to one owner agent and
returns owned cards, open approvals and human requests, active and stale claims,
next-action buckets, and relevant merge lanes for agent polling.

The staging service also implements `POST /api/agents/:agentId/claim-next`,
the first claim bot path. It uses the insight-ranked queue to skip human-only
work, select a claimable action, choose a PR/package/path/queue-item resource,
and create or renew a durable agent work lease. `dryRun: true` previews the
selected candidate without mutating state.

The staging service also implements `POST /api/claims/transfer`, an explicit
agent-to-agent handoff path. It keeps the claimed repo/resource stable, moves
ownership to the next agent, renews the lease, and records transfer metadata
plus `metadata.handoffs` history for audit and dashboards.

The staging service also implements `/api/repo-policies` for durable per-repo
queue policy. Policies expose `queueMode`, protected branches, required checks,
trusted actors, fork policy, and optional structured metadata backed by
`steward_repo_policies`. The steward applies these policy snapshots before
evaluation, scheduling, queue claims, integration planning, and webhook queue
updates.

The staging service also implements the first run runtime surface:

```text
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
```

Attempts are the staging version of the `steward_attempts` table. They store
owner id, heartbeat, terminal output/error, retry availability, and stale
recovery ownership so crashed workers can be detected and reclaimed.
Run events include per-run `seq` numbers and can be read with `afterSeq` for
polling, replay, and future streaming.

It also implements approval records through `GET /api/approvals`,
`POST /api/approvals`, and `POST /api/approvals/decide`. Run-scoped approvals
now update the run node, run status, and run event timeline when requested or
decided. Production can split the decision endpoint into RESTful approve/deny
routes once Eliza Cloud identity is attached.

Human requests and signals are also available in staging:

```text
GET  /api/human-requests
GET  /api/human-requests/item?id=human%3Arun-one%3Areview%3A0
POST /api/human-requests
POST /api/human-requests/respond
GET  /api/signals
POST /api/signals
POST /api/signals/consume
```

This gives the local steward a private inbox for maintainer prompts and a
correlated wakeup log for `waiting-event` runs before the production tables and
Eliza Cloud identity layer exist. Matching signals now resume staging
`waiting_event` runs by completing the waiting node, appending a run event, and
consuming the signal.

Agent claims are available in staging through:

```text
GET  /api/claims
GET  /api/claims/item?id=claim%3Aowner%2Frepo%3Apath%3Asrc%2Fcore.ts
POST /api/claims
POST /api/claims/renew
POST /api/claims/release
POST /api/claims/transfer
```

These endpoints provide the first private API for file/package/PR ownership
across many agents. They currently expose steward IDs and bearer/OIDC auth; the
Eliza Cloud product layer still needs user-facing labels, dashboards, and SSO
mapping.

## Event Gate Policy

Before a webhook can start or mutate a run, the steward should evaluate a pure
gate:

- provider event is allowlisted
- repository is configured
- PR exists and is open unless the event is closing/cleanup
- actor identity is known for agent-owned actions
- fork policy allows the source branch
- comment command, if present, came from an allowed maintainer or service
- delivery id is unique

The gate should return `{ allowed, reason, action }`. Blocked events should be
recorded for audit but must not mutate queue state.

The staging service already includes the first opt-in version of this gate for
signed Forgejo webhooks. Enable it with
`MERGE_STEWARD_EVENT_GATE_ENABLED=true` and configure repository, fork, event
kind, and trusted comment-command actor policy through environment variables.

## Merge Saga

Treat each landing attempt as a compensatable saga:

1. observe PR
2. evaluate policy
3. request human approval if needed
4. claim queue lane
5. create or reset integration branch
6. merge PR head into integration branch
7. wait for required checks
8. verify PR head/base still match
9. merge original PR
10. post receipt and release lane

Compensations:

- failed policy: post blocker comment and keep item unclaimed
- failed integration branch: mark attempt failed and leave branch for inspection
- stale head/base: release lane and request refresh
- failed merge: mark failed, post receipt, require human triage
- cancelled run: release lane, record cancellation event

This gives agents a workflow they can inspect, resume, and recover instead of a
hidden bot action.

## Eliza Product Surfaces

Highest-value UI surfaces:

- Approval inbox with repo, PR, risk, diff summary, and approve/deny.
- Queue dashboard with lane, claim owner, attempt count, current blocker.
- Run timeline with events, node output, errors, and receipts.
- Human request inbox for structured agent questions.
- Handoff view showing run owner, current branch, current node, and compact
  context summary.
