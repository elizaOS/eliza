# Eliza Merge Steward Design

## One Sentence

Eliza Merge Steward is the agent-native merge queue that Forgejo does not provide out of the box: it watches PRs, claims, checks, conflicts, and risk signals, then creates tested integration branches and merges only when policy is satisfied.

## Current Reality

We now have a tested Merge Steward private runtime seed, not a deployed
production merge queue.

Implemented:

- Policy scoring and queue scheduling.
- Durable queue claim lifecycle for local/private staging, including running,
  merged, failed, cancelled, attempt count, claim timestamps, and one running
  worker per repository/target lane.
- PR lifecycle gates for closed, merged, draft, and unmergeable pull requests.
- Agent plan-review gates: agent PRs need explicit plan and validation sections
  before entering the queue.
- Eliza agent run receipt gates: a PR can carry the durable
  workflow state that produced it, and stale, waiting-approval, unhealthy, or
  degraded runs are blocked.
- Structured queue comments.
- Signed Forgejo/Gitea webhook parsing.
- HTTP endpoint for signed Forgejo webhooks.
- Queue read APIs.
- In-memory and JSON-file queue stores for local/private staging.
- Optional read-only Forgejo API enrichment for PR metadata, changed files,
  reviews, and commit statuses.
- Dry-run integration branch planner and guarded executor boundary that selects
  ready queue items, returns planned branch/action metadata, and refuses live
  execution unless explicit production gates are satisfied.
- Live integration execution plans from persisted queue state instead of
  trusting request-body queue facts, and refreshes persisted items from Forgejo
  when enrichment is enabled.
- Opt-in `local-git` executor adapter that can prepare local integration
  worktrees, optionally push integration branches, wait for required checks, and
  perform the final Forgejo pull request merge after head/base revalidation.
- Forgejo status watcher for required integration checks.
- Optional bearer-token guard for non-webhook control API endpoints, with
  signed Forgejo webhooks kept on their HMAC path and request bodies capped by
  config.
- Webhook delivery ID replay suppression, with staging configured to require
  delivery IDs.
- Optional event gate that records but blocks untrusted or out-of-scope webhook
  deliveries before queue mutation.
- First-class approval records for private staging, with request/list/decision
  endpoints that update run/node state and append run events.
- First-class steward run, node, and event records for private staging, including
  computed run state for UI and agent handoff.
- First-class attempt records with owner heartbeats, terminal output/error, and
  stale recovery for crashed steward workers.
- Human request and external signal records for private staging, giving agents a
  structured maintainer inbox and correlated wakeups for blocked runs.
- First-class agent work claim/lease records for private staging, giving agents
  repo/resource ownership with TTL, renewal, release, and conflict responses.
- Durable merge worker lease records so multiple steward replicas do not
  auto-claim merge work concurrently.
- Audited human queue policy overrides that can clear explicitly overridable
  policy blockers without bypassing red checks or hard PR lifecycle gates.
- Agent coordination summary API for dashboard-ready queue, claim, run, owner,
  and hot-path state.
- Prometheus-compatible metrics for readiness, queue depth, run status, attempt
  status, agent claims, worker enablement, and worker lease ownership.
- Postgres production schema migration for queue items, runs, nodes, attempts,
  run events, approvals, human requests, signals, webhook deliveries, and repo
  policy, plus agent claim leases and worker leases.
- Database-backed runtime store wired into the Node service when `DATABASE_URL`
  is set, including row-locked queue claims and stale attempt recovery.
- Opt-in Forgejo feedback mirroring for steward-owned labels and comments, with
  dry-run default and loop prevention.
- Dockerfile, Forgejo CI workflow, and staging Compose wiring, including a
  one-shot `merge-steward-migrate` service that applies Postgres migrations
  before the steward HTTP service boots.

Not implemented yet:

- Eliza Cloud dashboard pane.

Forgejo provides the primitives:

- Pull requests and reviews.
- Protected branches and required checks.
- Forgejo Actions and runner-reported statuses.
- Webhooks for repository events.
- Swagger/OpenAPI-backed API access.
- Repo Projects for Kanban workflow.

The merge queue should be an Eliza-native service layered on top of those primitives, not a hard fork of Forgejo.

## Product Goals

- Keep `main` / `develop` green under high PR volume.
- Let many Eliza agents submit work without overwhelming maintainers.
- Prefer small, low-risk, unblocked PRs automatically.
- Hold or quarantine spammy, duplicate, risky, stale, or under-tested PRs.
- Explain every queue decision in structured PR comments.
- Give humans an override path without bypassing audit trails.
- Preserve Forgejo as the Git source of truth while Eliza Cloud provides identity, policy, and intelligence.

## Non-Goals

- Do not run untrusted code on the Forgejo host.
- Do not replace Git itself in v1.
- Do not fork Forgejo unless a missing extension point blocks core UX.
- Do not auto-merge code without clear branch protection and required checks.
- Do not make hidden queue decisions; every state transition should be inspectable.

## Core Concepts

### Queue Item

A queue item represents one PR plus steward metadata:

- `repo`
- `pull_request_id`
- `source_branch`
- `target_branch`
- `author_kind`: `human`, `agent`, `bot`
- `owner_agent_id`
- `task_id`
- `priority`
- `risk_score`
- `conflict_score`
- `affected_paths`
- `affected_packages`
- `required_checks`
- `last_check_result`
- `review_state`
- `queue_state`
- `retry_count`
- `blocked_reason`
- `created_at`
- `updated_at`

### Queue States

```text
observed
triaged
waiting_for_checks
waiting_for_review
ready
queued
running
building_integration
integration_failed
failed
cancelled
blocked_conflict
blocked_policy
blocked_stale
merged
closed
quarantined
```

### Labels

Use Forgejo labels as a human-visible state mirror:

```text
agent-owner:<agent-id>
agent:claimed
agent:stale
agent:stale-claim
agent:duplicate-risk
agent:needs-human
agent-submit:<state>
queue:ready
queue:queued
queue:building
queue:blocked
queue:merged
risk:low
risk:medium
risk:high
```

## Event Flow

1. Forgejo webhook fires on PR opened, synchronized, reopened, labeled, reviewed, or check completed.
2. Steward fetches current PR, commits, files, reviews, checks, labels, and branch state through the Forgejo API.
3. Steward computes:
   - risk score
   - conflict score
   - test requirements
   - owner/claim state
   - duplicate/stale signals
4. Steward writes queue state to its database.
5. Steward mirrors state back to Forgejo labels and comments when useful.
6. When a PR becomes `ready`, the scheduler may promote it to `queued`.
7. Steward creates or updates an integration branch, for example:

```text
refs/heads/eliza-queue/<target>/<queue-item-id>
```

8. Forgejo Actions runs required checks on the integration branch.
9. If checks pass and policy still holds, Steward merges the original PR or fast-forwards through the integration branch.
10. Steward posts a final structured queue receipt.

## Scoring

### Risk Score Inputs

- Changed line count.
- Number of files.
- Touched package criticality.
- Touches migrations, auth, billing, secrets, infra, runner config, or generated code.
- Test coverage touched or missing.
- Agent trust level.
- Prior failure rate for author/agent.
- PR age and rebase age.
- Number of prior retries.
- Whether PR is linked to an issue/task.

### Conflict Score Inputs

- Merge-base age.
- Files changed by queued PRs ahead of it.
- Files changed by recently merged PRs.
- Package-level overlap.
- Lockfile overlap.
- Migration overlap.

### Scheduling Strategy

Default queue ordering:

1. Human-approved emergency/security fixes.
2. Low-risk, green, reviewed PRs.
3. Agent PRs with clean ownership and narrow path impact.
4. Medium-risk PRs with complete tests.
5. High-risk PRs only after explicit human approval.

The planner only builds a merge train from low-risk, low-conflict PRs in the
same repository and target branch when their file/package impact is disjoint.
Repo policy `queueMode: batched` or `MERGE_STEWARD_INTEGRATION_BATCHING=true`
enables train selection; `policy.maxBatchSize` and
`MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE` cap the train size.

Live execution runs train items sequentially. Each PR gets an integration
branch and required checks, the steward revalidates and merges the original PR,
and the next train item starts from the updated target branch. If any item
fails, later items are blocked with `merge_train_predecessor_failed`.

### Claim Lifecycle

The staging steward now separates scheduling from claiming:

1. `scheduleQueue` computes policy-ready candidates and filters terminal or
   already-running items. Stacked PR children are not policy-ready until their
   parent PR dependencies have landed.
2. `claimNextQueueItem` atomically marks the first available candidate
   `running`, records `claimedBy`, `claimedAt`, and increments `attemptCount`.
3. The JSON store refuses another running item with the same `repo` and
   `targetBranch`, which gives private single-process staging a conservative
   serialized lane for each base branch.
4. Workers call `finishQueueItem` with `merged`/`cancelled` or `failQueueItem`
   with an error. Terminal items are not scheduled again unless a human or later
   production workflow explicitly resets them.

With `DATABASE_URL` set, the Node service uses Postgres for the same lifecycle
and performs row-locked queue claiming so multiple steward replicas do not claim
the same repository/target lane.

### Agent Claim Lifecycle

The staging steward also tracks finer-grained agent work claims:

1. An agent claims a repo resource through `POST /api/claims`, for example a PR,
   issue, branch, path, package, task, or queue item.
2. The steward accepts the claim when it is new, expired, released, or already
   owned by the same agent.
3. The steward rejects active unexpired claims owned by another agent with
   `already_claimed`.
4. Agents renew TTLs through `POST /api/claims/renew`, transfer ownership
   through `POST /api/claims/transfer`, and release ownership through
   `POST /api/claims/release`.

The JSON store deduplicates by repo/resource for local staging. The Postgres
store enforces the same invariant with a unique `(repo, resource_kind,
resource_id)` index and row-locked claim updates.

### Repository Policy Lifecycle

The staging steward stores per-repo merge policy through `/api/repo-policies`.
This is where Eliza Cloud can set queue mode (`disabled`, `serialized`, or
`batched`), protected branches, required checks, trusted actors, fork policy,
and any future structured policy metadata without redeploying the steward.
Policies are applied before evaluation, scheduling, queue claims, integration
planning, and webhook queue item updates. `disabled` queues block scheduling,
required checks are merged onto queue items, trusted actors can establish known
agent identity, and configured protected branches satisfy the protected-branch
gate.

## Policy Gates

A PR cannot merge unless:

- Target branch is protected.
- Required checks pass on the integration branch.
- Review policy is satisfied.
- PR is not stale relative to target.
- PR is not quarantined.
- Required labels are present.
- Blocked labels are absent.
- The PR still has the same head SHA that was evaluated.

Agent PRs additionally require:

- Known agent identity, and an allowed registry entry when
  `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true`.
- Linked task or issue.
- Optional durable run receipt from Eliza Cloud, with no pending
  approvals, unhealthy heartbeat, failed terminal state, or failed child agents.
- Optional verified run-receipt signature when
  `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true`.
- No direct push to protected branches.
- Token scope matches repo/action needs.
- No forbidden path changes without human approval.

## Comments

Steward comments should be structured and short.

Example ready comment:

```text
Eliza Merge Steward: queued

State: queued
Risk: low
Conflict: low
Checks: smoke, typecheck
Integration branch: eliza-queue/develop/1842
```

Example blocked comment:

```text
Eliza Merge Steward: blocked

State: blocked_policy
Reason: touches cloud auth and lacks human approval
Required: maintainer approval + cloud-api auth tests
```

## Agent UX

Agents should be able to ask:

- What is blocking my PR?
- What should I fix next?
- Can I safely rebase?
- Which files are hot conflict zones?
- Which PRs are duplicates?
- Which queue items can be batched?
- Which failing checks are likely flakes?

Eliza Cloud can expose this as a Git dashboard pane backed by the steward API.

## Deployment Shape

Recommended v1:

- Forgejo remains the Git web app.
- Eliza Cloud / Steward provides SSO.
- Merge Steward runs as a separate service.
- Steward DB starts with Postgres.
- Webhooks enter through a signed endpoint.
- Steward uses a Forgejo bot token with narrow permissions.
- Runners execute in isolated Docker or remote sandboxes.

## Current V0 API

```text
GET  /health
GET  /ready
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

## Suggested Product API

```text
GET  /api/forge/repos
GET  /api/forge/repos/:owner/:repo/queue
GET  /api/forge/repos/:owner/:repo/queue/:id
POST /api/forge/repos/:owner/:repo/queue/:id/enqueue
POST /api/forge/repos/:owner/:repo/queue/:id/dequeue
POST /api/forge/repos/:owner/:repo/queue/:id/retry
POST /api/forge/repos/:owner/:repo/queue/:id/override
POST /api/forge/webhooks/forgejo
```

## MVP Build Plan

1. Staging Forgejo on Hetzner with SSO and protected branches.
2. Steward service with webhook ingestion and read-only queue dashboard.
3. Label mirror and queue-state comments.
4. Single-PR integration branch builder.
5. Required Forgejo Actions checks on integration branches.
6. Merge only when integration branch is green and policy still holds.
7. Eliza Cloud dashboard pane for queue state.
8. Eliza Cloud dashboard pane for claim state.

## Test Plan

Unit:

- score calculation
- policy gate evaluation
- queue state transitions
- label/comment rendering
- stale head SHA protection

Integration:

- Forgejo webhook payload ingestion
- Forgejo API fetch/update calls
- integration branch creation
- check result polling
- merge attempt with protected branch policy

End-to-end staging:

- low-risk PR merges
- failing check blocks
- stale PR blocks
- conflict blocks
- human override works
- human override leaves red checks and hard lifecycle blockers intact
- agent duplicate PR is quarantined
- untrusted fork PR cannot access secrets

Security:

- webhook signature validation
- token scope audit
- runner isolation
- forbidden path rules
- audit log for override and merge actions

## Cool Later Ideas

- Queue simulation before enqueue.
- Predict likely conflict before an agent starts work.
- Cross-repo stack visualization once the queue spans more than Eliza-owned
  repositories.
- Agent reputation based on merge success, failure rate, and rollback rate.
- Natural-language queue command comments, for example `/eliza queue retry`.
- Automatic split suggestions for oversized agent PRs.
- PR "blast radius" visualization by package, owner, and runtime surface.
- Merge train with low-risk batching.

## Definition Of Done For "Super Merge Queue"

- A protected branch can receive many agent PRs without humans manually babysitting every green merge.
- Every queued PR is tested against the current target plus earlier queue items.
- Every block has a clear reason and next action.
- Untrusted code never runs on the Forgejo host.
- Humans can override policy with an audit trail.
- Eliza Cloud shows queue state, agent ownership, and CI failures in one place.
