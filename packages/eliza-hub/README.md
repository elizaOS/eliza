# Eliza Hub

Eliza Hub is an agent-native Git and work coordination surface:
Eliza-branded Forgejo for repos, issues, PRs, Projects, Actions, packages, and
wiki, plus Merge Steward for agent-scale queueing, claims, validation budgets,
run evidence, and merge policy.

This package is the open-source Eliza Hub deployment and development seed. It
intentionally excludes runtime databases, runner tokens, cloned repositories,
local passwords, generated Forgejo secrets, Terraform state, backups, and
production evidence.

## Status

Forgejo is a mature, production-capable Git forge. Eliza Hub packages Forgejo
with Eliza branding and adds Merge Steward for agent coordination and merge
policy. The package source and automated tests are ready for local and staging
use; a running instance is created only when an operator starts the stack.

| Surface | Status |
| --- | --- |
| Forgejo Git hosting, issues, PRs, releases, packages, wiki, and Kanban projects | Available when the Compose stack is running |
| Eliza dark and light themes | Included and enabled by the local configuration |
| Package checks and Merge Steward tests | Automated in the package and monorepo CI |
| Forgejo Actions | Enabled; at least one separately registered runner is required to execute jobs |
| Merge Steward APIs and dry-run queue planning | Implemented and tested |
| Live agent merges | Disabled until identity, persistence, runner, repository-protection, and private-evidence gates pass |
| Team-wide hosted access | Requires an operator-managed deployment, domain, TLS, authentication, backups, and monitoring |
| Eliza Cloud production cutover | Not performed by this source package |

In short: this repository is a tested distribution, not a running hosted
service. It can host real repositories locally as soon as the Compose stack is
started. Production readiness describes the target deployment, not the
maturity of Forgejo itself.

## Monorepo Quick Start

From the root of the `elizaOS/eliza` repository:

```sh
bun install
bun run --cwd packages/eliza-hub check
bun run --cwd packages/eliza-hub test
docker compose --project-directory packages/eliza-hub \
  -f packages/eliza-hub/compose.yml up -d
```

Open `http://127.0.0.1:3000`. The local Compose stack stores runtime data in
ignored paths under this package. Stop it with the same Compose arguments and
`down`; add `-v` only when you explicitly intend to delete local Forgejo data.

### Host a Repository Locally

The local configuration allows account registration and does not include a
default username or password. After opening Eliza Hub, register an account,
create an empty repository, and push an existing local repository to it:

```sh
git remote add eliza http://127.0.0.1:3000/YOUR_USER/YOUR_REPO.git
git push -u eliza HEAD
```

The repository can then use Forgejo issues, pull requests, reviews, releases,
packages, wiki, and Kanban projects without GitHub. Actions workflows require a
runner; use the isolated runner overlay described below before treating CI as
available. Merge Steward is optional for ordinary Git hosting and is required
only for the Eliza-specific agent coordination and merge-queue workflows.

The directory is also portable. After extracting `packages/eliza-hub` into its
own repository, run `npm ci --prefix services/merge-steward` before the same
package-local commands. The nested `.forgejo/workflows` files become active
when this directory is the repository root.

## Architecture and Readiness

Eliza Hub is a tested Forgejo distribution and production-oriented deployment
seed. Forgejo provides the Git forge. Merge Steward provides the agent-native
control plane that GitHub does not natively model: per-agent identities, work
reservations, queue simulation, CI budget checks, PR evidence, merge train
planning, release readiness, and deployment gates.

It works today for local/private repository hosting and as the base for a
private hosted staging deployment. The checked-in source is not itself an
operated Eliza Cloud service. A production cutover still requires domain, TLS,
SSO, backups, runner isolation, monitoring, branch-protection evidence, and a
staged live-merge rollout in the target environment.

## What This Provides

- Forgejo can mirror `elizaOS/eliza`.
- Forgejo has repo Projects with Kanban boards.
- Forgejo Actions can run local smoke jobs.
- Agents can have separate accounts and writable repos.
- The Eliza theme can be shipped as a normal Forgejo customization layer without forking Forgejo source.
- Merge Steward can add agent-native workflow controls around Forgejo without
  giving agents direct merge authority.

## GitHub Parity Notes

Forgejo is not complete GitHub parity.

The steward exposes a machine-readable parity matrix at `GET /api/github-parity`
and links it from `GET /.well-known/eliza-hub.json`, so Eliza Cloud and agents
can distinguish native Forgejo surfaces, Eliza-computed views, steward-owned
merge queue behavior, partial parity, delegated controls, and unsupported
GitHub-only surfaces. The matrix also marks that this is not a GitHub API
drop-in replacement, lists migration guardrails, and identifies surfaces that
remain production-evidence-gated.

The merge queue and project board expose planner-backed batch eligibility for
each ready item, including selected candidates and skipped-item reasons such as
`batch_impact_overlap`, `item_not_batch_safe`, and `max_batch_size`. Agents can
see why work was not included in a merge train before spending runner capacity.
Merge queue diagnostics also detect stacked PR dependencies from explicit
metadata or PR base branches, so agents can see which follow-up PRs are waiting
for a parent branch to land.
`POST /api/queue/simulate` lets agents and Eliza Cloud preview what a proposed
PR would do to queue order, batch eligibility, blockers, selected integration
plans, and existing queued work before any queue state is mutated.
`GET /api/merge-train` turns the current queue into a compact read-only
execution contract for agents and Eliza Cloud: selected PRs, integration
branches, required checks, lane blockers, dry-run blockers, a live-execution
preflight checklist, and the exact next action before `queue/run-once` is
allowed to mutate anything.
`GET /.well-known/eliza-hub.json` also exposes
`clientHints.mergeExecution`, a non-secret live/dry-run posture summary for
agents and Eliza Cloud. It deliberately separates live integration config from
production permission: live agent merges remain evidence-gated and are never
allowed solely because a worker or executor is enabled.
`GET /api/releases/notes` and `POST /api/releases/notes` turn merged PR facts
into grouped Markdown release drafts with package, agent, risk, and exclusion
summaries, so release notes can be generated from steward evidence instead of
manual PR scraping.
`POST /api/patch/conflict-prediction` lets agents and Eliza Cloud score a
proposed patch against open queued PRs, active file/package claims, hot lanes,
lockfiles, and migrations before an agent opens a PR or consumes runner
capacity.
`POST /api/review/assignment` suggests non-author reviewer agents and optional
owner agents from changed paths, affected packages, active claims, current
capacity, and performance evidence. Sensitive workflow, migration, environment,
or security paths still surface maintainer review hints.
`GET/POST /api/search` gives agents and Eliza Cloud natural-query search over
steward PR, queue, run, claim, human-request, approval, and signal context,
plus optional caller-supplied issue, diff, and Actions-log documents.
`GET /api/work-items`, `POST /api/work-items`, and
`POST /api/work-items/transition` persist durable Eliza-owned agent work
records with repo scope, owners, linked issues/PRs/tasks, paths, packages,
labels, cycle/module links, and Kanban-ready state. `GET/POST /api/work-cycles`,
`GET/POST /api/work-modules`, `GET/POST /api/work-views`,
`GET/POST /api/work-views/evaluate`, `GET/POST /api/work-pages`,
`GET /api/work-dashboard`,
`GET /api/work-progress`, and `GET /api/work-intake` add Eliza Work planning
snapshots for agent-scale Kanban, evaluated saved dashboards, agent plans, runbooks,
release notes, sprint-style coordination, and queue-to-work intake automation
previews. `POST /api/work-intake/apply` applies a preview only with explicit
confirmation.
`GET /api/agents/:agentId/cockpit` is the one-call read-only agent dashboard
for Eliza Cloud and agent runtimes. It composes workflow cards, work context,
focus cards, merge-train status, next actions, and links without creating work.
Plain GET cockpit reads stay situational; proposed-work decisions remain
explicit through `POST /api/agents/:agentId/action-plan`,
`POST /api/agents/:agentId/work-preflight`, and
`POST /api/agents/:agentId/submission-gate`. `GET
/api/queue/item/action-plan` gives an existing PR a read-only "what next?"
plan from queue policy, run state, workflow card, and merge-train evidence.
Queue workflow, inbox, and cockpit focus cards carry `links.queueItemActionPlan`
when they represent an existing PR, so an agent can jump from the card to the
full PR-scoped plan without guessing the endpoint shape. The cockpit also ranks
those links as `inspect_queue_item_action_plan` next actions when a focused PR
needs attention.
`GET /api/agents/:agentId/bootstrap` and `GET /api/work-context` also carry a
compact merge-train preflight snapshot so agents can see dry-run review state
and live-execution blockers while resuming work.

The steward also exposes `GET /api/production-readiness`, a machine-readable
launch checklist that keeps demo-ready status separate from production cutover,
and `GET /api/production-cutover`, an ordered cutover plan derived from the same
hard evidence gate requirements. It lists the private evidence blocks, helper scripts, gate
checks, and next actions that must pass before Eliza Cloud production traffic
or live agent merges are enabled. Domains that need more than one private
artifact expose ordered `helperSteps`, so agents can see prerequisites such as
SSO smoke capture before the final evidence fragment is generated.
`GET /api/production-evidence-template`
returns a schema-valid, non-passing evidence scaffold for private operator
state; it never stores or exposes live evidence.

For agent CI budgeting, `POST /api/ci/validation-plan` classifies proposed
validation commands before they run. It blocks broad Turbo/typecheck/build
commands by default and recommends package-scoped checks such as
`turbo run typecheck --filter=@elizaos/<package>`.
`POST /api/pr/brief` can include the same validation-budget result when callers
send proposed validation commands, so broad checks show up as review blockers
with scoped replacements before maintainers spend time on the PR. It also
surfaces work-reservation coverage from the agent submission gate, so
unreserved files/packages appear as review evidence and labels. Send
`requireWorkReservation: true` to make missing reservations review-blocking in
the brief.
`POST /api/agents/:agentId/submission-gate` also accepts validation commands and
can reject broad checks before an agent opens more work. It also inspects active
work reservations for proposed files and packages; missing reservations warn by
default and become blockers when callers send `requireWorkReservation: true`.

Agents can use the same gate before starting work that might consume shared
runner capacity:

```sh
node services/merge-steward/src/cli.js validation-plan <<'JSON'
{
  "repo": "elizaos/eliza",
  "changedFiles": ["packages/plugin-capacitor-bridge/src/index.ts"],
  "commands": ["turbo run typecheck"]
}
JSON
```

The command exits non-zero for broad validation and returns scoped replacement
commands.

Included:

- Git repos, branches, tags
- Issues, labels, milestones
- Pull requests and review basics
- Releases, packages, wiki
- Forgejo Actions
- Repo Projects with Kanban boards

Not equivalent:

- GitHub Discussions is not first-class here.
- GitHub Projects v2 tables/custom fields/roadmaps are richer than Forgejo Projects.
- GitHub Actions Marketplace compatibility is not guaranteed.
- Untrusted CI needs Docker isolation, not the host runner.

## Theme

The Eliza theme ships as standard Forgejo custom assets: CSS, local fonts, logo, favicon, and optional templates under Forgejo's custom path. The default theme is dark and follows the current Eliza frontend style: Poppins, black/white chrome, tight 3px radii, real Eliza logo assets, and restrained `#FF5800` accents.

Files:

```text
custom/public/assets/css/theme-eliza.css
custom/public/assets/css/theme-eliza-light.css
custom/public/assets/fonts/poppins/
custom/public/assets/img/logo.svg
custom/public/assets/img/favicon.svg
custom/templates/custom/footer.tmpl
```

Enable:

```ini
[ui]
THEMES = forgejo-auto,forgejo-light,forgejo-dark,eliza,eliza-light
DEFAULT_THEME = eliza
```

## Docker

For a dedicated hosted pilot, the checked-in Terraform stack under
`deployment/hetzner-staging/terraform/` provisions a protected Hetzner host,
static IPv4 address, firewall, Cloudflare-managed web record, DNS-only native
Git SSH record, and hardened cloud-init bootstrap. The web record defaults to
DNS-only so Git LFS, package, release-asset, and HTTPS push sizes are not bound
by Cloudflare proxy limits; proxying is an explicit post-TLS option. It uses an
R2-compatible S3 backend for remote state and remains plan-only until an
operator explicitly reviews and applies it. The release gate validates the
Terraform configuration without contacting a backend or creating
infrastructure.

```sh
deployment/hetzner-staging/scripts/validate-infrastructure.sh
```

Terraform owns these DNS records. Wrangler remains useful for creating the R2
state bucket, but it must not independently manage the same DNS resources.
See `deployment/hetzner-staging/terraform/README.md` for the credential scopes,
state setup, plan review, and first-host checks.

The deployment also includes dry-run-first age-encrypted off-site backup and
independent recovery tooling plus hardened systemd service/timer examples.
Production evidence is accepted only when the local bundle, immutable upload
receipt, downloaded ciphertext, and separate recovery receipt agree by hash.

Start Forgejo:

```sh
docker compose up -d
```

Open:

```text
http://localhost:3000
```

Start the local Docker-backed runner only after Docker is working:

```sh
docker compose -f compose.yml -f compose.runner.yml up -d
```

For staging, use `deployment/hetzner-staging/compose.actions-runner.yml`
instead. The staging runner scaffold avoids `:host` labels and does not mount
the host Docker socket.

Start the merge-steward service overlay only after setting private local secrets:

```sh
FORGEJO_STEWARD_TOKEN=... FORGEJO_WEBHOOK_SECRET=... \
  docker compose -f compose.yml -f compose.merge-steward.yml up -d
```

By default the overlay keeps queue state in the private Docker volume mounted at
`/state/queue.json`. Do not commit the live queue file. Set
`MERGE_STEWARD_DATABASE_URL` to use the Postgres-backed runtime store instead;
`DATABASE_URL` wins over `QUEUE_STORE_PATH` inside the service.

Forgejo label/comment feedback is opt-in and can mirror queue, risk, owner, and
claim state. Keep
`FORGEJO_FEEDBACK_ENABLED=false` or `FORGEJO_FEEDBACK_DRY_RUN=true` until the
bot token and webhook behavior have been validated on a private staging repo.
Read-only enrichment is also opt-in with `FORGEJO_ENRICHMENT_ENABLED=false` by
default.

For real deployments, set `MERGE_STEWARD_DEPLOYMENT_MODE=production`. That
startup mode fails closed unless the steward has Postgres persistence, control
API auth, webhook replay protection, a webhook secret, and a configured Forgejo
event gate. The default local compose overlay stays permissive for private demo
work.

The merge worker is opt-in with `MERGE_STEWARD_WORKER_ENABLED=true` and
`MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true`. It drives the durable
`run-once` merge path and should stay disabled until live integration, required
checks, bot token permissions, and runner isolation have been validated. When
enabled, the worker uses a durable `merge-queue` lease so multiple steward
replicas can be started without concurrently auto-claiming merge work.
`GET /api/workflows?repo=elizaos%2Feliza&targetBranch=develop` is the workflow
view surface: it returns scoped cards plus `operations` for steward readiness,
Forgejo Actions posture, runner evidence requirements, and merge-train
preflight state. Agent bootstrap, cockpit, and work-context responses compact
that same operations snapshot so agents can resume with one read-first packet.
Set `MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true` only after
agents are reserving work consistently; then agent PRs without covered file or
package reservations are blocked from queue scheduling and merge claiming.
Set `MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true` after queue-to-work
intake or manual Work item creation is part of the agent flow; then agent PRs
must link a durable Work item by PR, task, or issue before queue scheduling and
merge claiming. `POST /api/agents/:agentId/work-reservation` creates that
durable Work item by default for new reserved agent work, while dry runs only
return a planned Work item.
Set `MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true` before live agent
merges; then agent PR source branches must live under
`agent/<agent-id>/...`, and work preflight plus submission gates return the
expected namespace before the PR reaches the queue. Work preflight also returns
deterministic split plans for broad, hot, or conflicted proposed work so agents
can open smaller package/path PRs instead of flooding the queue. It compares
proposed scope with durable Work items too: in-progress foreign same-file Work
blocks duplicate starts, while planned or package-only Work overlaps stay as
coordination warnings. Production
live integration also requires
`MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` plus the secret named by
`MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV`, so agent PRs carry signed Eliza
run receipts before the steward can claim a live merge.
Production live integration also requires
`MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` with
`MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` listing bootstrap allowed Eliza agent
ids. Operators and Eliza Cloud can also manage active allowed agents through
the steward-owned `GET/POST /api/agent-identities` registry; strict policy uses
the union of the env bootstrap list and persisted active registry rows.
Production live integration refuses to start without all four controls.

Useful local endpoints:

```text
GET  /health
GET  /ready
GET  /.well-known/eliza-hub.json
GET  /openapi.json
GET  /metrics
GET  /api/workflows?repo=elizaos%2Feliza&targetBranch=develop
GET  /api/github-parity
GET  /api/production-readiness
GET  /api/production-cutover
GET  /api/production-evidence-template
GET  /api/project-board?repo=elizaos%2Feliza
GET  /api/work-items?repo=elizaos%2Feliza
POST /api/work-items
POST /api/work-items/transition
GET  /api/work-cycles?repo=elizaos%2Feliza
POST /api/work-cycles
GET  /api/work-modules?repo=elizaos%2Feliza
POST /api/work-modules
GET  /api/work-progress?repo=elizaos%2Feliza
GET  /api/work-views?repo=elizaos%2Feliza
POST /api/work-views
GET  /api/work-views/evaluate?id=view%3Aelizaos%2Feliza%3Adocs
POST /api/work-views/evaluate
GET  /api/work-pages?repo=elizaos%2Feliza
GET  /api/work-pages/item?id=page%3Aelizaos%2Feliza%3Awork%3Aexample%3Aagent_plan
POST /api/work-pages
POST /api/work-pages/transition
GET  /api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=agent-one
GET  /api/work-context?repo=elizaos%2Feliza&ownerAgentId=agent-one
GET  /api/work-dashboard?repo=elizaos%2Feliza
GET  /api/work-intake?repo=elizaos%2Feliza
POST /api/work-intake/apply
GET  /api/merge-train?repo=elizaos%2Feliza
GET  /api/merge-queue?repo=elizaos%2Feliza
GET  /api/search?q=failed+typecheck&repo=elizaos%2Feliza
POST /api/search
POST /api/queue/simulate
GET  /api/release-readiness?repo=elizaos%2Feliza
GET  /api/repository-protection?repo=elizaos%2Feliza
GET  /api/agent-insights?repo=elizaos%2Feliza
GET  /api/agents?repo=elizaos%2Feliza
GET  /api/agent-identities
GET  /api/agent-performance?repo=elizaos%2Feliza
GET  /api/agent-routing?repo=elizaos%2Feliza
GET  /api/agents/agent-one/bootstrap?repo=elizaos%2Feliza
GET  /api/agents/agent-one/cockpit?repo=elizaos%2Feliza
GET  /api/queue/item/action-plan?id=elizaos%2Feliza%2312&ownerAgentId=agent-one
POST /api/agents/agent-one/action-plan
POST /api/agents/agent-one/submission-gate
POST /api/agents/agent-one/work-preflight
POST /api/agents/agent-one/work-reservation
POST /api/ci/failure-analysis
POST /api/ci/validation-plan
POST /api/pr/brief
POST /api/review/assignment
POST /api/patch/conflict-prediction
GET  /api/releases/notes?repo=elizaos%2Feliza
POST /api/releases/notes
GET  /api/agents/agent-one/inbox?repo=elizaos%2Feliza
POST /api/agents/agent-one/claim-assignment
POST /api/agents/agent-one/claim-next
GET  /api/coordination
GET  /api/queue
GET  /api/queue/item?id=elizaos%2Feliza%2312
GET  /api/queue/item/run-state?id=elizaos%2Feliza%2312
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
GET  /api/claims
GET  /api/claims/item?id=claim%3Aelizaos%2Feliza%3Apath%3Asrc%2Fcore.ts
POST /api/claims
POST /api/claims/renew
POST /api/claims/release
POST /api/claims/transfer
GET  /api/repo-policies
GET  /api/repo-policies/item?repo=elizaos%2Feliza
POST /api/repo-policies
POST /api/comments/render
POST /api/webhooks/forgejo
```

The public agent discovery manifest is served at
`GET /.well-known/eliza-hub.json`. The machine-readable OpenAPI 3.1 contract
for Eliza Cloud and agent clients is served at `GET /openapi.json` and stored
at `services/merge-steward/openapi.json`.
The discovery schema keeps bootstrap-critical fields typed: auth mode, OIDC
issuer/audience hints, route bindings, Forgejo-vs-Eliza surface ownership,
agent branch namespace policy, run receipt policy, Work-item link policy,
agent identity registry posture, and live merge execution posture.

`GET /api/merge-queue` includes a `diagnostics` block for agent-native merge
ops: queue health, the next merge target, blocker groups, batch skip reasons,
per-agent required actions, and stuck/busy lane summaries.
Operators can seed the steward-managed agent registry with
`node services/merge-steward/src/cli.js agent-identities sync < agents.json`
after setting `MERGE_STEWARD_URL` and a steward API token.

Agent runtimes and Eliza Cloud integrations can import
`createMergeStewardClientFromEnv` from `@elizaos/eliza-hub-merge-steward` to discover the
service, read inbox/cockpit/routing/project-board views, manage durable work
items, claims, approvals, signals, runtime records, queue actions, queue-item
action plans, repository protection audits, CI failure analysis, PR review
briefs, review assignment, patch prediction, and release notes, and attach
bearer auth without hand-building steward URLs.

After a deploy, run the steward doctor against the private service URL before
routing traffic. It checks health, readiness, discovery, OpenAPI, metrics,
workflow cards, GitHub parity, production readiness, project board, merge
queue diagnostics, work items, work pages, fleet coordination, work context, agent identity
registry, agent insights, agent capacity, release readiness, repository
protection, agent performance, agent routing, queue simulation, agent
bootstrap, agent cockpit, agent action plan, agent submission gate, CI failure
analysis, validation plan, PR brief, and agent inbox endpoints:

```sh
npm run doctor --prefix services/merge-steward -- http://127.0.0.1:8787
```

For an actual production cutover, also collect private evidence for domain/TLS,
SSO, backups with retained audit artifact provenance, database migration with
retained audit/log provenance, runner isolation, repository protection,
secrets with retained audit artifact provenance, mail with retained audit
artifact provenance, storage with retained audit artifact provenance,
observability with retained audit artifact provenance, steward runtime, merge
queue rollout, and security review with retained audit provenance, then run:

```sh
node services/merge-steward/src/cli.js production-evidence-template > "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.template.json"
node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict
# Run the assemble command printed by the inventory helper after all fragments are present.
node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
```

## Binary Local Path

The original local POC used signed Forgejo and runner binaries in `bin/`. Those binaries are not committed here. Download and verify them separately, then copy:

```text
bin/forgejo-15.0.3-linux-amd64
bin/forgejo-runner-12.12.0-linux-amd64
```

Use `custom/conf/app.example.ini` as the starting point for `custom/conf/app.ini`.

## Runner Safety

The host runner is useful for trusted local smoke jobs only. It executes workflow commands directly on the machine and must not run untrusted PR code.

The host-runner scripts fail unless `ALLOW_LOCAL_HOST_RUNNER=true` is set for
that command. Use the Docker runner for anything closer to real CI.

## Roadmap Docs

- `docs/readiness.md` explains what is demo-ready versus what still needs production hardening.
- `docs/eliza-hub-roadmap.md` captures the deployment plan for Eliza Cloud SSO, Hetzner deployment prep, agent-native Git workflow, merge stewardship, and AI-assisted coordination.
- `docs/merge-steward-design.md` specifies the proposed agent-native merge queue service.
- `templates/merge-steward/config.example.yaml` is a starting config for a private staging merge steward.

## Demo Board Shape

A fresh deployment does not include the original proof-of-concept database or
its Kanban board. Recreate this board on the mirrored Eliza repository when
bootstrapping a demo:

```text
http://localhost:3000/elizaos/eliza/projects/1
```

Board name:

```text
Eliza Agent Workflow
```

Columns:

```text
Backlog
To Do
In Progress
Done
```
