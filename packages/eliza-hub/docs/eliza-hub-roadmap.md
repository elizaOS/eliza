# Eliza Hub Roadmap

This package is open source. Runtime screenshots, configuration, secrets,
database files, runner tokens, production evidence, and mirrored private data
remain private operator material and must never be committed.

## Product Name Direction

Use **Eliza Hub** as the product name for now.

Rationale:

- It is bigger than Git. The target surface includes repos, PRs, issues, agent
  claims, merge queues, cycles, docs, dashboards, and Cloud identity.
- It does not imply a hard Forgejo fork. Forgejo can remain the Git engine while
  Eliza Cloud and Merge Steward provide the agent-native layer.
- It leaves room for Eliza work management and durable agent workflows without
  renaming later.

Surface names:

- **Eliza Hub**: the whole product experience.
- **Eliza Git**: the Forgejo-backed repo, issue, PR, Actions, package, and wiki
  surface.
- **Eliza Work**: Eliza-native work items, cycles, modules, views, pages,
  intake, docs, and dashboards.
- **Merge Steward**: the internal service that owns policy, queueing, audited
  overrides, integration branches, and final merge execution.

## What Exists Now

- Open-source package with a clean Forgejo customization layer.
- Local Forgejo proof of concept for `elizaOS/eliza`.
- Real Eliza logo, favicon, local Poppins fonts, dark default theme, optional light theme.
- Mirrored `elizaOS/eliza` repo in the local Forgejo runtime.
- A repo-level Kanban project named `Eliza Agent Workflow`.
- Basic local accounts from the demo runtime.
- Forgejo Actions enabled in config, but the local runner should remain off unless deliberately testing trusted jobs.
- `@elizaos/eliza-hub-merge-steward` private runtime seed:
  - signed Forgejo webhook endpoint
  - optional read-only PR/file/review/status enrichment
  - queue policy and scheduler
  - guarded integration branch execution boundary
  - queue read APIs
  - JSON-backed private staging queue state
  - Postgres-backed runtime store when `DATABASE_URL` is set
  - steward run, node, attempt, approval, human request, signal, and event APIs
  - agent work claim/lease APIs for issues, PRs, branches, paths, packages,
    tasks, and queue items
  - agent-to-agent claim transfer for explicit work handoff
  - agent coordination summary API for queue lanes, active/stale claims,
    per-agent ownership, run state, blockers, hot paths, and hot packages
  - agent insights API for failed-check routing, stale branches, stale claims,
    overlapping PR detection, and ranked next actions
  - release-readiness API for repo merge-window go/no-go decisions across
    queue, runtime, human, and agent health signals
  - repository-protection API for checking durable repo policy against live
    Forgejo branch-protection and required-check evidence
  - production-readiness API for mapping launch blockers to private evidence
    blocks, helper commands, and production-gate checks
  - queue simulation API for read-only previews of proposed PR policy,
    scheduling, batch eligibility, selected plans, blockers, stack dependency
    impact, and queue displacement before agents mutate queue state
  - CI validation-plan API that rejects broad agent validation commands and
    suggests package-scoped checks before shared runners are consumed
  - agent claim-next route that converts ranked insight work into durable leases
  - OIDC-capable API auth path for Eliza Cloud-issued bearer tokens
  - steward-owned persisted agent identity registry for Eliza Cloud-managed
    allowed agents in strict live merge policy
  - migration runner with checksum drift protection
  - runtime preflight checks with a strict production deployment mode
  - final Forgejo merge adapter behind explicit live-execution gates
  - durable `run-once` worker path that claims one PR or one safe merge train
    and records run/node/attempt state
  - opt-in merge worker loop guarded by explicit live-execution confirmation and durable worker lease ownership
  - Prometheus-compatible Merge Steward metrics for staging observability
  - deployment doctor CLI for post-boot health/readiness/metrics and product API verification
  - Dockerfile and Forgejo CI workflow
  - unit tests for policy, comments, CLI, webhooks, storage, and HTTP endpoints

This is now a polished demo plus a serious steward runtime seed. It is
not yet a production Eliza Cloud service because hosted staging, SSO, TLS,
backups, runners, monitoring, and live Eliza Cloud identity are not wired.

The next architecture layer is documented in
[`steward-runtime-model.md`](./steward-runtime-model.md): durable steward runs,
run nodes, attempts, approvals, human requests, signals, webhook deliveries,
computed run state, event gates, and compensating merge sagas.

## GitHub Capability Reality

Forgejo covers a lot of the core GitHub surface:

- Git repos, branches, tags, mirrors, web file browsing.
- Issues, labels, milestones, pull requests, reviews, releases, packages, wiki, activity.
- Forgejo Actions workflows and runners.
- Repo Projects as Kanban boards for issues.
- Protected branches and required review/check gates.
- API tokens and API access for automation.

Forgejo is not full GitHub parity:

- GitHub Discussions is not a first-class equivalent here.
- GitHub Projects v2 tables, custom fields, roadmaps, and saved views are richer than Forgejo Projects.
- GitHub Actions Marketplace compatibility is not guaranteed; Forgejo Actions are close but not identical.
- GitHub merge queue is not configured here, and Forgejo does not become a GitHub-scale merge queue by just enabling Actions.
- GitHub org-level governance, rulesets, code owners, security features, and marketplace integrations need separate evaluation.

`GET /.well-known/eliza-hub.json` makes this explicit for clients through a
`surfaces` map: Git and Actions are Forgejo-owned, Project Board and Merge Queue
views are Eliza Steward computed surfaces, and Discussions are marked
`not_supported_as_native_discussions` until a first-class sync exists.
The same manifest exposes `clientHints.mergeExecution` so agents can distinguish
dry-run mode, live integration config, worker confirmation, and durable lease
posture without treating those settings as production merge approval.
`GET /api/github-parity` expands this into a machine-readable matrix for
Eliza Cloud and agent clients, including native, computed, steward-owned,
partial, delegated, planned, and unsupported surfaces plus agent-native
additions that intentionally go beyond GitHub. Each surface also carries a
cutover disposition: `cutoverBlocker`, `requiredEvidence`,
`requiredGateChecks`, `cutoverReadiness`, `migrationTarget`, `targetApis`, and
`nextAction`. Public API responses do not include private evidence, so blocking
surfaces report `private_evidence_required`. Operators can run
`eliza-merge-steward github-parity [--strict] < eliza-hub-production-evidence.json`
to score the same matrix against private production evidence before cutover.
Use those fields as the migration checklist: core Git, PRs, Actions, branch
protection, merge queue, security, and org-scale governance stay blocked until
their named production evidence paths and gate checks pass;
Projects v2 is an intentional Eliza Work replacement; Discussions and
Codespaces are explicit accepted gaps rather than hidden parity claims.
`GET /api/production-readiness` keeps launch status machine-readable without
checking in private evidence. It tells Eliza Cloud, operators, and agents which
production-gate checks, evidence blocks, helper scripts, and next actions still
block a real cutover.

## Eliza Cloud SSO Direction

Goal: a user signs into Eliza Cloud once and can open the Git forge without an extra account flow.

Preferred path:

1. Make Eliza Cloud / Steward act as an OpenID Connect provider for Forgejo.
2. Configure Forgejo as an OAuth2/OIDC client named `elizacloud`.
3. Use stable claims:
   - `sub` for immutable Eliza Cloud user id.
   - `email` and `email_verified` for account linking.
   - `preferred_username` or an Eliza handle for Forgejo username.
   - `groups` / `roles` for org membership and admin mapping.
4. Disable normal public registration on the production forge.
5. Allow automatic user creation only from the Eliza Cloud OIDC issuer.
6. Keep local admin recovery credentials out of Git and in the server secret store.

Possible Forgejo CLI shape for staging, with placeholder values:

```sh
forgejo admin auth add-oauth \
  --provider=openidConnect \
  --name=elizacloud \
  --key="$ELIZA_CLOUD_FORGEJO_CLIENT_ID" \
  --secret="$ELIZA_CLOUD_FORGEJO_CLIENT_SECRET" \
  --auto-discover-url="https://cloud.example.com/.well-known/openid-configuration" \
  --scopes="openid email profile groups"
```

If Eliza Cloud cannot expose OIDC yet, build or enable a small OIDC broker in the Cloud API/Steward layer before trying to force this into Forgejo templates.

## Eliza Cloud App Integration

Short term:

- Host Forgejo on a subdomain such as `git.eliza.example`.
- Add an Eliza Cloud dashboard link to the forge.
- Use SSO so the transition feels like one product.

Medium term:

- Build an Eliza Cloud `Git` pane that consumes the Forgejo API for high-value views:
  - assigned PRs/issues
  - agent claims
  - merge queue status
  - CI failures
  - repo/project boards
- Start that pane with `GET /api/coordination` from `@elizaos/eliza-hub-merge-steward`,
  then deep-link to Forgejo for raw repo operations.
- Keep deep links to the raw Forgejo UI for advanced repo operations.

Avoid iframe-first integration unless there is a strong reason. Forgejo works better as a same-brand sibling app with shared identity.

## Hetzner Deployment Prep

Good staging target:

- Hetzner VM or dedicated box.
- Docker Compose or systemd-managed Forgejo.
- Caddy, nginx, or Traefik for TLS and reverse proxy.
- Domain such as `git.eliza.cloud` or private staging equivalent.
- Postgres for production-ish staging if the repo grows beyond SQLite comfort.
- Dedicated volumes for repositories, attachments, LFS, packages, logs, custom config, and database.
- Nightly encrypted backups to separate storage.
- Mail configured for notifications and account recovery.
- Runner pool isolated from the Forgejo web server.

Do not run untrusted agent PR code on the host. Use Docker runner isolation at minimum; ideally remote ephemeral runners or sandboxed workers.

## Agent-Native Additions

These are the pieces that make this more than a theme:

- Agent accounts and service identities:
  - one user or bot identity per agent
  - branch namespace convention like `agent/<agent-id>/<task-slug>`
  - token lifecycle managed from Eliza Cloud, not manually pasted forever
- Claim and lease workflow:
  - issues/PRs can be claimed by an agent
  - claims expire, transfer, or can be released
  - UI labels show ownership and stale work
  - implemented in `@elizaos/eliza-hub-merge-steward` as `/api/claims` plus
    `POST /api/claims/transfer` and `POST /api/agents/:agentId/claim-next`
    with JSON and Postgres storage; opt-in Forgejo feedback now mirrors
    steward-owned owner and claim labels, while the richer Eliza Cloud UI still
    needs product wiring
- Agent Kanban templates:
  - Backlog
  - Ready
  - Claimed
  - In Progress
  - Needs Human Review
  - Merge Queue
  - Done
- PR summarizer:
  - generated summary
  - changed-risk areas
  - tests run
  - missing verification
  - conflict likelihood
  - CI validation-budget blockers and scoped replacement commands
  - low-signal commit hygiene with rollup requirements
  - reviewer assignment summary from path/package/capacity evidence
  - first deterministic brief now exists at `POST /api/pr/brief`
- Release note generator:
  - groups merged PRs into release sections
  - summarizes agent and package contributions
  - returns Markdown for Forgejo or Eliza Cloud release drafts
  - first deterministic generator now exists at `GET/POST /api/releases/notes`
- CI failure triage:
  - parse Forgejo Actions logs
  - classify infra flake vs real failure
  - suggest owner and next action
  - first deterministic router now exists at `POST /api/ci/failure-analysis`
- CI validation budget:
  - catch broad Turbo/typecheck/build commands before agents run them
  - recommend package-scoped checks for changed packages
  - first deterministic planner now exists at `POST /api/ci/validation-plan`
- Spam and overload controls:
  - rate limits per agent before bursty PR creation floods the queue
  - quarantine untrusted agent PRs
  - require issue link or task id
  - throttle per-agent open PR depth before one agent floods the queue
  - block broad validation commands before an agent opens more work
  - first deterministic pre-submit gate now exists at `POST /api/agents/:agentId/submission-gate`
  - preflight proposed files/packages against active claims and open PRs before an agent starts a branch
  - deterministic split guidance for broad, hot, or conflicted proposed work
  - first deterministic work preflight with split plans now exists at `POST /api/agents/:agentId/work-preflight`
  - reserve proposed files/packages as durable claims after a clean preflight
  - first deterministic work reservation now exists at `POST /api/agents/:agentId/work-reservation`
  - predict proposed patch conflicts against queued PRs, active claims, hot
    lanes, lockfiles, and migrations before branch or PR creation
  - first deterministic patch conflict predictor now exists at
    `POST /api/patch/conflict-prediction`
  - suggest non-author reviewer agents from changed paths, affected packages,
    active claims, capacity, and performance evidence
  - first deterministic review assignment scorer now exists at
    `POST /api/review/assignment`
  - collapse low-signal commits into a review summary, now surfaced through
    PR brief `commitHygiene`
- Coordination dashboards:
  - active agents
  - claimed files/packages
  - stale branches
  - queued PRs
  - red builds
  - hot conflict zones
- Repo search:
  - natural-query search over steward PRs, queue state, claims, runs, human
    requests, approvals, signals, and supplied issue/diff/Actions-log documents
  - first deterministic search API now exists at `GET/POST /api/search`

## Eliza Work Direction

Eliza Hub should treat work management as a first-class product layer rather
than a thin issue list.

- Work items should support list, Kanban, calendar, timeline, and spreadsheet
  views.
- Work items should connect to repos, PRs, agent claims, runs, cycles, modules,
  pages, and releases.
- Cycles and modules should carry progress snapshots, not just board columns.
- Saved views should power common dashboards such as "my agents", "blocked PRs",
  "needs human", "hot packages", and "merge queue".
- Intake/triage should stay separate from accepted queue work; the first
  queue-to-work preview/apply API now exists at `GET /api/work-intake` and
  `POST /api/work-intake/apply`.
- Durable work pages now sit next to work items for agent plans, runbooks,
  release notes, decisions, specs, and notes via `GET/POST /api/work-pages`.
- Dashboards should show queue health, failed checks, agent claims, conflict
  hotspots, and current human decisions.

## Merge Queue Direction

Current state: a tested Merge Steward runtime exists, including Postgres-backed
queue state, row-locked queue claims, attempt recovery, claims/leases,
per-repository policy APIs that feed queue decisions, and a guarded final
Forgejo merge adapter. It also exposes a coordination summary for dashboard
views, merge queue diagnostics for health/next-target/blocker explanations,
stacked PR dependency state, and a durable `run-once` worker endpoint that
claims one ready PR or one safe same-lane merge train, creates
run/nodes/attempt records, executes the
integration plan, and finishes, fails, or requeues each queue item. When safe
batching is enabled, the worker requeues unattempted successors if a predecessor
fails. Postgres claims use lane-scoped advisory locks so one active train can
hold a lane without blocking its own rows, and the worker recovers stale active
items before claiming more work.
An opt-in worker loop can drive that path behind durable worker lease
ownership, but no production merge queue is deployed or allowed to merge real
PRs yet.

Minimum viable approach:

1. Protect `main` / `develop`.
2. Require review and status checks.
3. Require Forgejo Actions smoke checks.
4. Add a bot-managed label such as `merge-queue`.
5. Connect signed Forgejo webhooks to `POST /api/webhooks/forgejo`.
6. Only the merge steward bot merges PRs that pass policy.

Agent-native approach:

- Build `eliza-merge-steward`.
- Steward owns a queue table:
  - PR id
  - priority
  - agent/human owner
  - required checks
  - affected packages
  - conflict status
  - retry count
- Steward rebases or creates a temporary integration branch.
- Steward runs required isolated checks.
- Steward merges only if the integration branch is green and the PR is still approved.
- Steward posts structured comments for why a PR is blocked.

This is the part that becomes the Eliza-owned coordination layer for agent work.

The next production step is to run the durable worker in a real staging drill
with an isolated runner pool, then wire scoped `GET /api/workflows` cockpit
payloads, including `operations` for Actions, runner evidence, and merge-train
preflight,
`GET /api/production-readiness`,
`GET /api/project-board`, `GET /api/merge-queue`,
`GET/POST /api/work-cycles`, `GET/POST /api/work-modules`,
`GET/POST /api/work-views`, `GET/POST /api/work-views/evaluate`, `GET/POST /api/work-pages`,
`GET /api/work-dashboard`,
`GET /api/work-intake`, `POST /api/work-intake/apply`,
`GET /api/work-progress`,
`GET /api/merge-train`,
`GET/POST /api/search`,
`GET /api/release-readiness`, `GET /api/repository-protection`,
`GET /api/agent-insights`, `GET /api/agents`,
`GET /api/agent-performance`, `GET /api/agent-routing`,
`GET /api/agents/:agentId/cockpit`,
`POST /api/agents/:agentId/action-plan`,
`POST /api/agents/:agentId/work-preflight`,
`POST /api/agents/:agentId/work-reservation`, `POST /api/pr/brief`, and
`POST /api/review/assignment` into Eliza Cloud, then route
`GET /api/agents/:agentId/inbox` into Eliza Cloud
dashboards and agent polling.
Humans and agents should see shared workflow cards, Kanban columns, merge lanes,
owner-specific next actions, timeline,
approval records, recovery state, and a safe place to resume or cancel
long-running merge work.

## AI Features Worth Building First

Highest value:

- PR summary, risk classifier, and commit-hygiene rollup gate, now started
  with deterministic `POST /api/pr/brief` review briefs.
- CI log summarizer and failure router, now started with deterministic
  `POST /api/ci/failure-analysis` classification and later ready for hosted LLM
  summaries.
- CI validation-budget guard, now started with deterministic
  `POST /api/ci/validation-plan`.
- Merge queue steward.
- Agent capacity and performance-aware assignment router, now surfaced through `GET /api/agents` and `POST /api/agents/:agentId/claim-assignment`.
- Agent performance telemetry, now surfaced through `GET /api/agent-performance`.
- Compact agent routing recommendations, now surfaced through `GET /api/agent-routing`.
- Agent startup snapshot, now surfaced through `GET /api/agents/:agentId/bootstrap`,
  including compact merge-train preflight state.
- One-call agent cockpit, now surfaced through
  `GET /api/agents/:agentId/cockpit`.
- Agent next-action plans that compose routing, search, validation, conflict,
  submission, and review evidence, now surfaced through
  `POST /api/agents/:agentId/action-plan`.
- Repo release-readiness gate, now surfaced through `GET /api/release-readiness`.
- Repo protection audit, now surfaced through `GET /api/repository-protection`.
- Agent spam and overload gate, now surfaced through `POST /api/agents/:agentId/submission-gate`.
- Agent work preflight and split-plan gate, now surfaced through `POST /api/agents/:agentId/work-preflight`.
- Agent work reservation gate, now surfaced through `POST /api/agents/:agentId/work-reservation`.
- Patch conflict prediction before branch or PR creation, now surfaced through
  `POST /api/patch/conflict-prediction`.
- Suggested reviewer/agent assignment based on changed paths and owner load,
  now surfaced through `POST /api/review/assignment`.
- Agent claim/lease bot, now started with `POST /api/agents/:agentId/claim-next`.
- Stale branch and duplicate PR detector, now surfaced through `GET /api/agent-insights`.
- Project board automation from issue/PR state, building on `GET /api/project-board`.
- Merge train execution contracts for agents and Eliza Cloud, now surfaced
  through `GET /api/merge-train`, including live-execution preflight checks
  for missing required checks, dry-run mode, and active merge lanes.
- Eliza Work cycles/modules, saved views, evaluated view payloads, pages, dashboards, and progress snapshots
  for agent-scale planning,
  now surfaced through `GET/POST /api/work-cycles`,
  `GET/POST /api/work-modules`, `GET/POST /api/work-views`,
  `GET/POST /api/work-views/evaluate`, `GET/POST /api/work-pages`, `GET /api/work-dashboard`,
  `GET /api/work-intake`,
  `POST /api/work-intake/apply`, and `GET /api/work-progress`.
- Auto-generated release notes from merged PRs, now surfaced through
  `GET/POST /api/releases/notes`.
- Natural-query repo search over steward state and supplied issue/diff/Actions
  log documents, now surfaced through `GET/POST /api/search`.

Later:

- Hosted LLM summarization on top of deterministic CI failure, PR brief,
  release-note, and assignment evidence.

## Production Gate

Before this is "ready for Eliza Cloud":

- SSO staged and tested.
- Public registration locked down.
- Backups tested with restore.
- Runner isolation tested.
- Required checks and protected branches configured.
- Mail and notification routing configured.
- Monitoring and logs configured.
- Upgrade/rollback documented.
- Merge Steward production preflight enabled and green at `/ready`.
- Security review of auth, tokens, runner execution, and repo permissions.
