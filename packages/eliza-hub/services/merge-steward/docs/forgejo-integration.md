# Forgejo Integration Boundary

This package keeps Forgejo-specific HTTP and webhook details out of the merge
queue core.

## Webhooks

`src/webhook.js` accepts raw Forgejo/Gitea-compatible webhook deliveries and
normalizes queue-relevant payloads into internal event objects.

Supported event families:

- Pull request lifecycle: `pull_request`
- Pull request sync: `pull_request_sync`
- Pull request labels: `pull_request_label`
- Pull request reviews: `pull_request_review_approved`,
  `pull_request_review_rejected`, `pull_request_review_comment`
- Pull request timeline comments: `pull_request_comment`
- Commit statuses: `status`
- Actions workflow updates: `workflow_run`, `workflow_job`

Validate the raw request body before parsing JSON:

```js
import { parseForgejoWebhook } from '../src/webhook.js';

const event = parseForgejoWebhook({
  headers: request.headers,
  rawBody,
  secret: process.env.FORGEJO_WEBHOOK_SECRET,
});
```

Forgejo signs deliveries with HMAC-SHA256. The helper accepts
`X-Forgejo-Signature`, `X-Gitea-Signature`, `X-Gogs-Signature`, and the
GitHub-compatible `X-Hub-Signature-256` header.

The HTTP service wires this parser at:

```text
POST /api/webhooks/forgejo
```

Pull request events create or refresh queue entries. Status and workflow events
only enrich an existing entry when their head SHA matches a queued pull request.
This webhook route uses HMAC authentication and does not require the steward
control API bearer token.

Webhook delivery IDs are stored before any queue mutation. Replayed delivery IDs
are accepted as duplicate no-ops so old signed deliveries do not reapply labels,
comments, or queue state. Staging sets
`MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID=true`.

## Read-Only Enrichment

Enable enrichment after the webhook path is working:

```sh
FORGEJO_ENRICHMENT_ENABLED=true
FORGEJO_PROTECTED_BRANCHES=main,develop
FORGEJO_REQUIRED_CHECKS=smoke,typecheck
```

Enrichment uses the Forgejo client to read PR metadata, changed files, reviews,
combined status, and commit statuses. It updates queue facts such as
`changedFiles`, `changedLines`, `reviewSatisfied`, `targetProtected`,
`requiredChecks`, `checkResults`, and PR lifecycle state. Closed, merged, draft,
and explicitly unmergeable PRs are blocked by policy even when checks are green.
Agent-authored PRs also need reviewable `Plan` and `Validation` sections in the
title/body before they can become queue-ready.

If the API read fails, the steward keeps the webhook-derived queue item and
still accepts the webhook delivery. If the API head SHA differs from the
webhook/stored SHA, the steward sets `headShaMatches=false` and ignores old
statuses so stale green checks cannot unblock a changed PR.

## Integration Planning And Execution

The integration layer has a non-mutating planner, a manual execution endpoint,
and a durable queue-worker endpoint:

```text
GET  /api/queue/integration-plan
POST /api/queue/integration-plan
POST /api/queue/integration-execution
POST /api/queue/run-once
```

When `MERGE_STEWARD_API_AUTH_REQUIRED=true`, these control endpoints
require `Authorization: Bearer <MERGE_STEWARD_API_TOKEN>`.

It uses the same policy scheduler as the queue, selects ready items, generates
branch names under `MERGE_STEWARD_INTEGRATION_BRANCH_PREFIX`, and returns the
future action sequence. Safe batching can select multiple low-risk,
low-conflict PRs in the same repo/target lane only when their changed
files/packages are disjoint. The planning endpoint does not call Forgejo write
APIs, push refs, trigger Actions, or merge PRs.

Live multi-PR execution runs those safe batches as a sequential merge train.
Each PR is tested on an integration branch, revalidated, and merged before the
next train item starts from the updated target branch. If one item fails, later
items are blocked with `merge_train_predecessor_failed`.

`POST /api/queue/integration-execution` is stricter than the planner. It only
executes when integration is enabled, dry-run is disabled, the request includes
`confirm: true`, required checks are present, and an injected executor client
implements every planned action. Before the final merge action, it verifies the
current pull request head SHA still matches the planned SHA.

Live execution ignores caller-supplied queue facts and builds its executable
plan from persisted queue state. With read-only enrichment enabled, persisted
items are refreshed from Forgejo before scheduling; refreshed check results
replace stored check results, and refresh failures block live execution for that
item. Dry-run planning continues to accept request-body `items` for local
experiments.

`POST /api/queue/run-once` is the worker path for the merge queue. It refuses
to claim work unless live integration is enabled and the request includes
`confirm: true`; then it claims one persisted ready item or one safe merge
train, creates steward runs with queue-claim and integration nodes, records
attempts, executes the plan, and marks each item plus run succeeded, failed, or
requeued when a predecessor blocks the train.

The long-running worker loop runs the same operation repeatedly when
`MERGE_STEWARD_WORKER_ENABLED=true` and
`MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true`. Keep the worker disabled
until live integration has been validated on a private staging repo. The worker
uses a durable lease before each auto-claim so multiple replicas do not process
merge work concurrently. The Postgres store uses lane-scoped advisory locks to
allow one active train per repo/target lane, and the worker requeues stale
`running` or `building_integration` items after
`MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS`.

Set `MERGE_STEWARD_INTEGRATION_EXECUTOR=local-git` to use the bundled local Git
adapter. It requires `MERGE_STEWARD_INTEGRATION_REMOTE_URL` and is still safe by
default because branch pushing is disabled unless
`MERGE_STEWARD_INTEGRATION_PUSH_BRANCH=true`. The adapter implements
integration-check waiting by polling Forgejo combined status and commit status
APIs for the planned required checks, then performs the final Forgejo PR merge
only when live execution is enabled and the head SHA is still current. Check
wait results preserve per-check state, target URL, status id, description, and
Actions run id when Forgejo exposes that metadata.

## Feedback Mirroring

The steward can mirror decisions back to Forgejo with labels and comments, but
the feature is disabled by default. Enable dry-run first:

```sh
FORGEJO_FEEDBACK_ENABLED=true
FORGEJO_FEEDBACK_DRY_RUN=true
```

Dry-run responses include planned operations without writing to Forgejo. Live
mode requires `FORGEJO_BASE_URL` and the bot token environment variable named by
`FORGEJO_TOKEN_ENV`.

The mirroring layer deliberately avoids destructive label replacement. It adds
desired steward labels and removes only steward-owned labels:

```text
queue:*
risk:*
agent-owner:*
agent:claimed
agent:needs-human
agent:stale
agent:stale-claim
agent:duplicate-risk
agent-submit:*
```

It does not remove identity labels such as `agent:agent-one`.

## Surface Authority

`GET /.well-known/eliza-hub.json` exposes a `surfaces` map so Eliza Cloud and
agent clients know which APIs are Forgejo-native and which are Eliza-computed:

- Git repositories, pull requests, issues, releases, packages, wiki, and Actions
  remain Forgejo-owned.
- `GET /api/project-board` is an Eliza-computed Kanban view from steward queue
  state, not Forgejo Projects v2 synchronization.
- `GET /api/merge-queue` is Merge Steward policy state, not a native Forgejo
  merge queue.
- Discussions are not a native Forgejo-equivalent surface here. Use PR comments,
  human requests, approvals, and signals until a discussion sync is explicitly
  added.

## Client

`src/forgejo-client.js` is a small fetch-based API wrapper. It only constructs
URLs, attaches headers, serializes JSON bodies, parses responses, and exposes
queue-facing methods for pull requests, labels, comments, statuses, and workflow
checks.

Inject `fetchImpl` in tests to avoid network calls:

```js
import { ForgejoClient } from '../src/forgejo-client.js';

const client = new ForgejoClient({
  baseUrl: 'http://localhost:3000',
  token: process.env.FORGEJO_STEWARD_TOKEN,
  fetchImpl: localFetch,
});
```

Do not commit real bot tokens or webhook secrets. Keep them in local environment
variables referenced by deployment config.
