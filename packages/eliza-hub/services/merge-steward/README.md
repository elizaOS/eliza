# Eliza Merge Steward

Private runtime seed for the agent-native merge queue described in `../../docs/merge-steward-design.md`.

This package currently contains the deterministic core:

- risk scoring
- conflict scoring
- merge policy gates
- PR lifecycle gates for closed, merged, draft, and unmergeable PRs
- agent plan and validation gates for agent-authored PRs
- optional agent run receipt gates for Eliza workflow state
- queue scheduling
- durable queue claim, finish, and fail lifecycle for local/private staging
- audited human policy overrides for queue blockers that are intentionally overridable
- short structured comments
- signed Forgejo webhook ingestion
- webhook delivery ID replay suppression
- optional Forgejo event gate before queue mutation
- first-class approval request/decision records with run-state transitions for local/private staging
- steward run, node, and event records for local/private staging
- steward attempt heartbeat, terminal state, and stale recovery records
- human request and external signal records with waiting-run resume for local/private staging
- agent work claim/lease records for issue, PR, branch, path, package, task, and queue-item ownership
- per-repository merge policy records for queue mode, protected branches, checks, trusted actors, and fork policy
- agent coordination summary for dashboard-ready queue, claim, run, owner, and hot-path state
- workflow cockpit view joining queue items, claims, runs, approvals, human requests, next actions, and readiness state
- project board view grouping workflow cards into agent Kanban columns, lane
  summaries, merge queue state, stacked PR waiting context, and planner-backed
  batch candidate/skip reasons
- durable work items for Eliza-owned agent intake, with repo scope, owners,
  linked tasks/issues/PRs, paths, packages, labels, cycles, modules, and
  Kanban-ready state
- durable Eliza Work cycles, modules, saved views, dashboards, and progress
  snapshots for agent-scale planning views
- durable Eliza Work pages for agent plans, runbooks, release notes, specs,
  decisions, and notes linked to work items, cycles, modules, PRs, issues, and
  tasks
- read-only fleet coordination contract for agent lane tags, claim protocol,
  board flow, evidence rows, and shared-lever exclusivity
- read-only work-context resume packets that combine agent identity, inbox,
  Work pages, dashboards, fleet locks, queue health, search results, and next
  links into one startup call
- read-only agent cockpit packets that combine workflow cards, work context,
  focus cards, merge-train status, situational posture, and next links for one
  owner agent
- read-only queue simulation for proposed PRs before agents mutate queue state
- natural-query repo search over steward state plus supplied issue, diff, and
  Actions-log documents
- read-only agent action plans that compose bootstrap, inbox, routing, search,
  preflight, validation, submission, conflict, and review evidence
- read-only patch conflict prediction for proposed files/packages before agents
  reserve work or open PRs
- reviewer and owner-agent assignment suggestions from changed paths, affected
  packages, active claims, current capacity, and performance evidence
- production readiness checklist that maps launch blockers to private
  evidence blocks, helper scripts, production-gate checks, and next actions
- release readiness gate for repo merge-window go/no-go decisions across queue,
  runtime, human, and agent health signals
- repository protection audit for durable policy, live Forgejo branch protection,
  and required-check evidence before live agent merges
- agent insights view for failed-check routing, stale branches, overlapping PRs, stale claims, and ranked next actions
- agent capacity and routing views for owner load, health, idle slots,
  unassigned PRs, and performance-aware assignment suggestions
- agent bootstrap and inbox views for owner-specific identity status, policy
  hints, cards, claims, next actions, and merge lanes
- agent claim transfer route for explicit agent-to-agent handoff of active work
- agent claim-assignment route that turns capacity suggestions into durable claim leases
- agent claim-next route that turns insight-ranked work into a durable claim lease
- validation-plan API for blocking broad Turbo/typecheck/build commands before
  agents consume shared runner capacity
- PR brief commit-hygiene checks for detecting low-signal agent commit streams
  and requiring a reviewer-facing rollup before review
- release-notes API for turning merged PR facts into grouped Markdown release
  drafts with agent, package, and risk summaries
- Postgres production schema migrations and runtime store for the steward model
- queue state storage for local/private staging
- optional bearer auth for control API endpoints
- request body size limits
- optional read-only Forgejo API enrichment
- guarded integration branch execution boundary
- optional Forgejo label/comment feedback mirroring for queue, risk, owner, and
  claim state

Forgejo label/comment feedback is opt-in and dry-run by default. Keep it that
way until the bot token, labels, and webhook behavior have been tested on a
private staging repo.

Read-only enrichment is also opt-in. When enabled, it fetches PR metadata,
files, reviews, and commit statuses so webhook observations can become complete
queue decisions without adding merge authority.

Integration planning is deterministic and non-mutating. The execution endpoint
is guarded: live execution requires integration enabled, dry-run disabled,
`confirm: true`, required checks, and an injected executor client. Without those
conditions it returns blocked/skipped metadata instead of mutating Forgejo.
When live execution is enabled, request-body queue facts are ignored and the
steward plans from persisted queue state.
Queue workers can claim one ready item or one safe same-lane merge train at a
time, increment attempt counts, and persist completion, retry, or failure state
in the JSON store used by local/private staging.
Agents can also claim finer-grained work leases such as files, packages, PRs,
or tasks. Claims expire, renew, release, and deduplicate on repo/resource so
many agents can coordinate before they create overlapping branches.
Active claims can be transferred between owner agents through
`POST /api/claims/transfer`, preserving the repo/resource lease while recording
latest handoff metadata and a durable `metadata.handoffs` history on the claim.
Agents can call `POST /api/agents/:agentId/claim-next` to let the steward route
the next claimable item from current insights, preview the claim with
`dryRun: true`, and then create or renew a durable lease through the same claim
store.
Agents and Eliza Cloud can call `POST /api/queue/simulate` before enqueueing
new PR work. The response compares the current queue with the proposed item or
items, reports policy decisions, queue positions, selected integration plans,
batch eligibility, blockers, and displaced work, and never mutates steward
state.
Agents and Eliza Cloud can call `GET /api/merge-train` to turn the current
queue into a compact read-only train contract: selected PRs, integration
branches, required checks, lane blockers, dry-run blockers, a live-execution
preflight checklist, and the exact next action before `queue/run-once` is
allowed to mutate anything.
Bootstrap clients can read `GET /.well-known/eliza-hub.json` for
`clientHints.mergeExecution`, which summarizes integration enabled/dry-run
state, worker confirmation, durable lease posture, batching, and branch push
posture without exposing remotes, local paths, tokens, lease IDs, or private
evidence. The hint always marks live agent merges as production-cutover and
private-evidence gated.
Agents and Eliza Cloud can call `GET /api/search` or `POST /api/search` to
find PRs, queue items, claims, runs, human requests, approvals, signals, and
caller-supplied issue, diff, or Actions-log documents with natural query text.
The response returns `{ search }` with ranked results, match evidence,
snippets, facets, and labels without mutating steward state.
Agents and Eliza Cloud can call `GET /api/work-items`, `POST /api/work-items`,
`GET /api/work-items/item`, and `POST /api/work-items/transition` for durable
Eliza-owned work intake records. The records are separate from Forgejo-native
issues/PRs, but can link back to them through `issueId`, `pullRequestId`,
`taskId`, `cycleId`, `moduleId`, `paths`, `packages`, and `sourceUrl`.
Agents and Eliza Cloud can call `GET/POST /api/work-cycles`,
`GET/POST /api/work-modules`, `GET/POST /api/work-views`,
`GET/POST /api/work-views/evaluate`, `GET/POST /api/work-pages`,
`GET /api/work-dashboard`,
`GET /api/work-context`,
`GET /api/work-progress`, and `GET /api/work-intake` for Eliza Work planning.
Cycles model sprint/release windows, modules model owned repo areas, saved
views model reusable filters/layouts, evaluated views return concrete list,
Kanban, linked-page, cycle, and module payloads, work pages preserve agent
plans, runbooks, release notes, decisions, specs, and notes, dashboard snapshots
summarize ready, active, blocked, and done work by cycle/module/view, and
intake previews convert observed queue PRs into durable work-item
create/update/transition actions. `POST /api/work-intake/apply` applies
selected intake actions only with explicit confirmation.
Agents and Eliza Cloud can call `POST /api/patch/conflict-prediction` with
proposed changed files and affected packages before PR creation. The response
returns `{ prediction }` with same-file and same-package queued PR overlaps,
active claim conflicts, hot paths/packages, migration or lockfile warnings,
labels, and a recommended coordination or split strategy.
Agents and Eliza Cloud can call `POST /api/review/assignment` with the same
proposed files and packages to get `{ assignment }` with ranked non-author
reviewer agents, suggested owner agent, excluded candidates, sensitive-path
maintainer hints, labels, and required actions. The scorer combines registered
agent metadata, current capacity, performance health, and active claims.
Eliza Cloud can call `GET /api/agents` to see per-agent health, current load,
available slots, stale ownership, unassigned PRs, and deterministic assignment
suggestions for work that has not been claimed yet. Assignment suggestions use
agent performance telemetry to avoid routing fresh work to overloaded or
triage agents.
Eliza Cloud can call `GET /api/agent-performance` to see per-agent throughput,
failed runs, stale claims, current load, and handoff ratios for dashboards and
routing decisions.
Eliza Cloud and agents can call `GET /api/agent-routing` to get the compact
recommendation list plus routable and blocked agent summaries without pulling
the full capacity payload.
Eliza Cloud can call `GET /api/release-readiness` before a merge window to
combine queue blockers, selected integration plans, runtime readiness, open
human decisions, stack dependency order, and agent stale/failed work into one
deterministic go/no-go gate. Stack-blocked children surface a
`stack_dependency_order` check and `stack:blocked` label. Add
`requireRepositoryProtection=true` to make this gate fail closed unless the repo
protection audit is production-ready.
Eliza Cloud can call `GET /api/repository-protection` before enabling live
agent merges to compare the durable repo policy with live Forgejo branch
protection and required-check evidence. Use `requireLive=true` for production
cutover checks so missing Forgejo evidence fails closed.
Agents can call `POST /api/agents/:agentId/claim-assignment` to accept the
next capacity-based assignment suggested for that owner and create the
corresponding durable claim lease.
Agents can also send `validationCommands`, `requestedValidationCommands`, or a
precomputed `validationPlan` to `POST /api/agents/:agentId/submission-gate`.
The gate rejects broad Turbo/typecheck/build commands before a new PR is opened
or more runner capacity is consumed. It also enforces per-agent queue depth and
recent-submission rate limits so one agent cannot keep opening PRs while its
existing queue is already near or above the configured flood threshold.
Agents can call `POST /api/agents/:agentId/work-preflight` before starting a
branch to compare proposed files and packages against active claims, open PRs,
durable Work items, and hot work areas. The response returns `{ preflight }`
with blockers, warnings, overlaps, suggested claims, deterministic split plans,
and labels for agent orchestration. Foreign in-progress same-file Work item
overlap blocks duplicate starts; planned or package-only Work item overlap warns
so agents can coordinate or link existing Work before runner time is spent. The
`preflight.splitPlan` field tells agents when broad or conflicted work should be
split by package/path lane, which split units are ready, which need watch
acknowledgment, and which need human/agent coordination before more PRs enter
the queue.
Agents can then call `POST /api/agents/:agentId/work-reservation` with the same
payload to run the preflight and create durable path/package claims in one
request. Real reservations create or update a durable Eliza Work item by
default, so strict Work-item enforcement can pass before a PR exists. Pass
`workItem` with `taskId`, `title`, or other Work fields when the planner already
knows the durable record; pass `createWorkItem: false` only for claim-only
experiments. Use `dryRun: true` for smoke checks or planner previews; dry runs
return `plannedWorkItem` but do not leave leases or Work items behind.
Repository policies can be managed through the API so Eliza Cloud can set
per-repo queue mode, protected branches, required checks, trusted actors, and
fork policy without changing process-level config. The steward applies these
policies before queue evaluation, scheduling, claims, integration planning, and
webhook queue updates.
If an agent PR includes an `Agent Run` or `Eliza Run` section,
the steward blocks stale, waiting-approval, failed, or degraded runs before they
enter the merge queue. Set `MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT=true` once
Eliza Cloud reliably attaches receipts to require this for every agent PR. Set
`MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` once Eliza Cloud signs
receipts with the secret named by `MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV`.
Set `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` with
`MERGE_STEWARD_AGENT_IDENTITY_REGISTRY=agent-a,agent-b` as the bootstrap
allowed-agent list. Eliza Cloud or an operator token can then manage the
steward-owned persisted registry through `GET/POST /api/agent-identities`;
strict mode trusts the env bootstrap list plus persisted active rows over
PR-supplied `agentKnown` facts.
Operators can seed or rotate that registry with
`node services/merge-steward/src/cli.js agent-identities sync < agents.json`
after setting `MERGE_STEWARD_URL` and a steward API token.
The bundled `local-git` executor can prepare and optionally push integration
branches, wait for required checks, revalidate the PR head/base, and perform
the final Forgejo PR merge when live execution is explicitly enabled.

## Commands

```sh
npm test --prefix services/merge-steward
npm run check --prefix services/merge-steward
node services/merge-steward/src/cli.js validation-plan < validation-request.json
```

Runtime dependencies are intentionally small: `pg` for the Postgres store and
`jose` for OIDC bearer validation.

Set `MERGE_STEWARD_DEPLOYMENT_MODE=production` before exposing the service
beyond local/private staging. Production mode fails startup unless Postgres,
control API auth, Eliza Cloud OIDC, webhook delivery replay protection, a
webhook secret, and a configured Forgejo event gate are present. Static API
tokens remain available for machine or break-glass access, but production must
also set `MERGE_STEWARD_OIDC_ENABLED=true` with an issuer, discovery or JWKS
URL, audience, at least one required role/group gate, and at least one admin
role/group gate for privileged operations. Production live integration also requires
`FORGEJO_ENRICHMENT_ENABLED=true` so PR reviews, files, head SHA, and checks are
refreshed from Forgejo immediately before merging. It also requires
`MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true`,
`MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true`, and
`MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true` so live agent merges only
run for reserved work with durable Work-item links from source branches under
`agent/<agent-id>/...`. Signed
agent run receipts are also required in production live mode:
`MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` and the secret named by
`MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV` must be present. Production live
mode also requires `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` and a
non-empty bootstrap or steward-managed allowed-agent registry.
`local` mode remains permissive for demo work; `staging` mode reports
staging-only warnings.

Set `MERGE_STEWARD_WORKER_ENABLED=true` only after live integration is ready.
The worker requires `MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true` and uses
the durable `run-once` path to claim one PR or one safe merge train per poll,
record run/node/attempt state, and finish, fail, or requeue each item. Worker
replicas coordinate through the durable worker lease configured by
`MERGE_STEWARD_WORKER_LEASE_ID`, `MERGE_STEWARD_WORKER_LEASE_TTL_MS`, and
`MERGE_STEWARD_WORKER_LEASE_HEARTBEAT_INTERVAL_MS`. Before each claim, the
worker also recovers stale `running` or `building_integration` queue items older
than `MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS`, fails their orphaned run
records for audit, and requeues the PR.

The production Postgres schema lives in `services/merge-steward/db/migrations/`.
Set `DATABASE_URL` to use the database-backed store before running multiple
steward replicas.

Run the local API wrapper:

```sh
PORT=8787 npm start --prefix services/merge-steward
```

`GET /api/workflows?repo=owner%2Frepo&targetBranch=develop` returns the scoped
workflow view with workflow cards, steward control-plane readiness, Forgejo
Actions posture, runner evidence requirements, and merge-train preflight state.

Endpoints:

```text
GET  /health
GET  /ready
GET  /.well-known/eliza-hub.json
GET  /openapi.json
GET  /metrics
GET  /api/workflows?repo=owner%2Frepo&targetBranch=develop
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
GET  /api/agents/agent-one/bootstrap?repo=owner%2Frepo
GET  /api/agents/agent-one/cockpit?repo=owner%2Frepo
GET  /api/queue/item/action-plan?id=owner%2Frepo%2312&ownerAgentId=agent-one
POST /api/agents/agent-one/action-plan
POST /api/agents/agent-one/submission-gate
POST /api/agents/agent-one/work-preflight
POST /api/agents/agent-one/work-reservation
POST /api/ci/failure-analysis
POST /api/ci/validation-plan
POST /api/pr/brief
POST /api/review/assignment
POST /api/patch/conflict-prediction
GET  /api/releases/notes?repo=owner%2Frepo
POST /api/releases/notes
GET  /api/agents/agent-one/inbox?repo=owner%2Frepo
POST /api/agents/agent-one/claim-assignment
POST /api/agents/agent-one/claim-next
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

The public agent discovery manifest is served at
`GET /.well-known/eliza-hub.json`. The machine-readable OpenAPI 3.1 contract
for generated clients and Eliza Cloud integration checks is served at
`GET /openapi.json` and lives at `openapi.json`.
The discovery manifest keeps bootstrap-critical fields typed in OpenAPI:
non-secret auth and OIDC hints, route bindings, Forgejo-vs-Eliza surface
ownership, branch namespace policy, run receipt policy, Work-item link policy,
agent identity registry posture, and live merge execution posture.
GitHub/Forgejo parity is explicit through `GET /api/github-parity`, which
identifies native Forgejo surfaces, Eliza-computed views, steward-owned merge
queue behavior, partial/delegated parity, and unsupported GitHub-only surfaces.
It also returns migration guardrails, maturity markers, and non-drop-in
replacement flags so Eliza Cloud can decide what to route to Forgejo, Steward,
or external tooling.
Production launch blockers are explicit through
`GET /api/production-readiness`, which lists required private evidence blocks,
helper commands, ordered helper steps, authoritative production-gate checks, and
next actions without exposing live secrets or evidence files.
`GET /api/production-cutover` turns the same hard gate into ordered phases,
guardrails, helper commands, helper steps, and final verification commands for
cutover.
`GET /api/production-evidence-template` returns a schema-valid, non-passing
evidence scaffold for private operator state without storing or accepting live
evidence.
Merge queue diagnostics are explicit through `GET /api/merge-queue`: the
response includes queue health, the next merge target, blocker groups, batch
skip reasons, stacked PR dependency diagnostics, per-agent required actions,
and stuck/busy lane summaries for Eliza Cloud dashboards and agent polling
loops. Stack diagnostics infer parent/child PRs from explicit dependency
metadata or PR target branches that point at another queued PR source branch,
then report waiting, broken, missing, or cycle states and feed the same queue
policy used by scheduling, simulation, integration planning, and worker claims.
Stacked children stay blocked until their parents land.
Merge train planning is explicit through `GET /api/merge-train`: the response
is read-only and turns the selected queue plan into an agent-facing execution
contract with PR order, integration branches, required checks, dry-run/live
blockers, lane next actions, live-execution preflight checks, and queue-run
links.
Single-item evaluation through `POST /api/queue/evaluate` also merges the input
with the persisted queue context before policy evaluation, so a child PR can be
reported as stack-blocked even when the caller submits only that one item.
Queue simulation is explicit through `POST /api/queue/simulate`: the response
compares current queue state with proposed PR items, reports selected plans,
batch eligibility, blockers, queue displacement, stack dependency impact, and
safe next actions without creating queue rows or claims.
Repo search is explicit through `GET/POST /api/search`: the response ranks
steward PR/queue/run/claim/human-request/approval/signal context and optional
caller-supplied issue, diff, or Actions-log documents for natural query text,
returning snippets and facets for agent UIs without using hosted LLMs.
Agent startup is explicit through `GET /api/agents/:agentId/bootstrap`, which
returns identity registry status, policy hints, resolved agent links,
inbox/routing summaries, active/stale claims, compact merge-train preflight
state, and safe next actions without mutating steward state.
Agent cockpit reads are explicit through `GET /api/agents/:agentId/cockpit`,
which returns a read-only `{ cockpit }` packet by joining workflow operations,
work context, owned focus cards, merge-train status, and ranked next actions.
Plain GET reads stay situational; proposed-work gates remain explicit through
the work-preflight, action-plan, and submission-gate endpoints.
Workflow, inbox, and cockpit focus cards for existing PRs expose
`links.queueItemActionPlan`, a direct read-only jump to the PR-scoped plan that
combines queue policy, run state, workflow card state, and merge-train evidence.
The cockpit also surfaces those links as `inspect_queue_item_action_plan`
next actions for focused PR cards that need attention.
Agent action planning is explicit through `POST /api/agents/:agentId/action-plan`,
which composes bootstrap, inbox, routing, repo search, work preflight,
validation-budget, submission-gate, conflict-prediction, and review-assignment
evidence into one read-only `actionPlan` with checks, labels, and ranked next
steps.
Agent validation budgets are explicit through `POST /api/ci/validation-plan`,
which classifies proposed commands before they run, blocks broad
Turbo/typecheck/build work by default, and returns scoped package-level
recommendations for affected Eliza packages.
PR review briefs can include that same budget by sending `validationCommands`,
`requestedValidationCommands`, or a precomputed `validationPlan` to
`POST /api/pr/brief`; blocked broad validation becomes a review reason,
verification gap, label, and list of scoped replacement commands.
PR review briefs also accept `item.commits` plus `item.commitSummary`. When an
agent PR has many `wip`, `fix`, `update`, repeated, or otherwise low-signal
commit subjects without a rollup, the brief returns
`commitHygiene.state: "needs_summary"`, adds a `commit_summary` verification
gap, and labels the PR with `commits:needs-summary` and `agent:commit-noise`.
Supplying a concise `commitSummary` keeps noisy local history reviewable
without pretending the steward rewrote Git history.
Review assignment is explicit through `POST /api/review/assignment`. It is
read-only and ranks non-author reviewer agents from registered expertise,
changed paths, affected packages, active claims, current capacity, and
performance health, while sensitive paths still emit maintainer review hints.
Fleet coordination is explicit through `GET /api/fleet-coordination`. It is
read-only and returns the agent lane-tag rules, board column flow, claim
protocol, evidence rows, shared exclusive resources, active/stale shared-lever
claims, and next actions agents should read before starting work.
Agent resume context is explicit through `GET /api/work-context`. It is
read-only and returns `{ workContext }`, a compact startup packet with identity,
owned cards, Work pages, dashboard/progress summaries, shared-lever blockers,
queue health, merge-train preflight state, search hits, read-first links, and
next actions for one `ownerAgentId`.
Patch conflict prediction is explicit through `POST /api/patch/conflict-prediction`.
It is read-only and scores proposed patch facts against active claims, queued
PR files/packages, hot lanes, lockfiles, and migrations before an agent reserves
work or opens a PR.
Release note drafts are explicit through `GET /api/releases/notes` for
persisted queue state and `POST /api/releases/notes` for caller-supplied merged
PR facts. The response groups merged PRs into release sections, summarizes
agent and package contributions, reports excluded PR evidence, and returns
Markdown that can seed a Forgejo release or Eliza Cloud release note.
The same policy is available locally through the CLI and exits non-zero when an
agent proposes broad runner-expensive validation:

```sh
node services/merge-steward/src/cli.js validation-plan <<'JSON'
{
  "repo": "elizaos/eliza",
  "changedFiles": ["packages/plugin-capacitor-bridge/src/index.ts"],
  "commands": ["turbo run typecheck"]
}
JSON
```

The package also exports a small client for Eliza Cloud and agent runtimes. It
preserves reverse-proxy base paths, fetches public discovery docs without auth,
adds bearer auth to `/api/*` calls, encodes agent IDs, and throws structured
`MergeStewardClientError` failures. Named helpers cover discovery, health,
metrics, typed discovery summaries, workflow views, parity/readiness views,
production readiness and cutover summaries with ordered helper steps, project
and queue views, queue simulation, stack dependency graphs, queue-item action
plans, agent bootstrap, cockpit, inbox, action plans, submission gates,
work preflight, work reservation, fleet coordination, work context, routing,
agent identity registry, approvals, repository protection, human requests,
signals, claims, repo policies, runs, run nodes, run attempts, run events,
queue execution, CI failure analysis, PR validation planning, review briefs,
review assignment, patch prediction, release notes, rendered comments, and
signed Forgejo webhook submission:

```js
import { createMergeStewardClientFromEnv } from "@elizaos/eliza-hub-merge-steward";

const steward = createMergeStewardClientFromEnv();

const discovery = await steward.getDiscoverySummary();
if (discovery.agentPolicy.branchNamespaceRequired) {
  // Create agent PR branches under discovery.agentPolicy.branchNamespacePattern.
}
const startup = await steward.getAgentBootstrapSummary("agent-one", {
  repo: "elizaos/eliza",
  readiness: false,
});
if (startup.startup.blocked) {
  // Resolve startup.blockingReasons before opening more PRs or running CI.
}
const simulation = await steward.simulateQueue({
  repo: "elizaos/eliza",
  proposedItem: { pullRequestId: 12, targetBranch: "develop" },
});
const bootstrap = await steward.getAgentBootstrap("agent-one", {
  repo: "elizaos/eliza",
  readiness: false,
});
const inbox = await steward.getAgentInbox("agent-one", {
  repo: "elizaos/eliza",
  readiness: false,
});
const preview = await steward.claimNext("agent-one", {
  repo: "elizaos/eliza",
  dryRun: true,
});
const reservation = await steward.reserveAgentWork("agent-one", {
  repo: "elizaos/eliza",
  changedFiles: ["packages/core/src/runtime.ts"],
  affectedPackages: ["core"],
  dryRun: true,
});
```

The env factory reads `MERGE_STEWARD_URL` plus `MERGE_STEWARD_API_TOKEN`,
`MERGE_STEWARD_TOKEN`, or `ELIZA_MERGE_STEWARD_TOKEN`.

Set `MERGE_STEWARD_API_AUTH_REQUIRED=true` and `MERGE_STEWARD_API_TOKEN` before
exposing any `/api/*` route outside loopback. Forgejo webhooks keep using their
separate HMAC signature secret.

`GET /health` is a liveness probe. `GET /ready` performs a queue-store read and
reports critical runtime configuration such as control API auth, webhook secret
presence, deployment mode, runtime preflight errors/warnings, active store
backend, and integration/enrichment/feedback modes. Use `/ready` for deployment
readiness and load-balancer checks.
`GET /metrics` exposes low-cardinality Prometheus text metrics for readiness,
queue depth, runs, attempts, claims, worker enablement, and worker leases. It
uses the same bearer/OIDC guard when
`MERGE_STEWARD_METRICS_AUTH_REQUIRED=true`.

`POST /api/queue/item/override` requires `id`, `approvedBy`, and `reason`.
Optional `blockers` limits the override to specific policy blockers. Overrides
can unblock human-reviewable policy gates such as missing agent plan,
validation, run receipt, sensitive path approval, high conflict risk, or unknown
agent quarantine. They do not bypass missing or failed checks, stale head SHA,
closed/merged/draft/unmergeable PR state, disabled repo queues, or other hard
merge-safety gates. Applying or clearing an override writes an audit event and
also appends run events for any steward run attached to that queue item.

`POST /api/queue/run-once` is the durable merge worker path. It requires live
integration execution to be enabled and `confirm: true`; then it claims one
policy-ready queue item or safe merge train, creates steward runs, records nodes
and attempts, executes the integration plan, and marks each queue item plus run
succeeded, failed, or requeued when a predecessor blocks the train.

Use it from scripts or agents:

```sh
node services/merge-steward/src/cli.js evaluate < item.json
node services/merge-steward/src/cli.js schedule < items.json
node services/merge-steward/src/cli.js comment < decision.json
npm run preflight --prefix services/merge-steward
npm run doctor --prefix services/merge-steward -- http://127.0.0.1:8787
node services/merge-steward/src/cli.js discovery-summary http://127.0.0.1:8787
node services/merge-steward/src/cli.js domain-evidence https://git.example.invalid/
node services/merge-steward/src/cli.js runner-isolation < runner-evidence.json
node services/merge-steward/src/cli.js production-evidence-template > "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.template.json"
node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict
# Run the assemble command printed by the inventory helper after all fragments are present.
node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
node services/merge-steward/src/cli.js agent-identities sync < agents.json
npm run worker --prefix services/merge-steward
```

The doctor command checks `/health`, `/ready`, discovery, OpenAPI, runtime
preflight, worker lease readiness when applicable, required `/metrics` series,
and the workflow, GitHub parity, production readiness, project board, merge
queue diagnostics, work items, work pages, fleet coordination, work context, agent identity
registry, release readiness, repository protection, agent insights, agent
capacity, agent performance, agent routing, queue simulation, agent bootstrap,
agent cockpit, agent action plan, agent submission gate, CI failure analysis,
validation plan, PR brief, and agent inbox APIs. Set
`MERGE_STEWARD_DOCTOR_TOKEN` when the target requires bearer auth. Set
`MERGE_STEWARD_SMOKE_REPO` and
`MERGE_STEWARD_SMOKE_AGENT` when the target smoke repo or agent id differs
from the defaults.

The discovery-summary command fetches public discovery and prints normalized
auth, route, surface, agent policy, production readiness, parity, and merge
execution hints for Eliza Cloud or agent bootstrap scripts.

The domain evidence command probes the live Forgejo HTTPS root and emits the
`domain` object consumed by the production gate. It sets TLS and canonical URL
booleans from the probe, but leaves `reverseProxyReviewed` false unless that
manual review has been explicitly recorded.

The runner isolation command converts rendered runner Compose/config text plus
private launch evidence into the `evidence.runner` object consumed by the
production gate. It stays non-zero until static isolation, runner registration,
a trusted `runs-on: docker` smoke workflow verified through Forgejo Actions,
egress review, and secret exposure review are all recorded.

The production gate is intentionally evidence-driven. It fails closed until a
private evidence JSON proves domain/TLS, SSO, backup restore, Postgres
migration with retained database audit/log provenance, digest-pinned image
provenance with retained audit artifact provenance, runner isolation, branch
protection, secret management, mail, storage, observability, steward production
readiness, staged merge-queue rollout, and security review. Use
`production-evidence.schema.json` for editor and release-tool validation of the
evidence shape. The gate reports `evidenceShape` errors and remains the
authoritative production cutover check. Use `production-gate --strict` for
cutover rehearsals and production launch checks; strict mode re-reads the
private backup audit, database audit/log, image provenance, SSO, runner,
repository, secret management, mail smoke, storage retention, observability,
steward, merge-queue rollout, and security review source artifacts referenced
by the evidence summary, then validates launch timestamp freshness. Automation
can also set `PRODUCTION_GATE_VALIDATE_ARTIFACTS=true` and
`PRODUCTION_GATE_VALIDATE_FRESHNESS=true` explicitly.
