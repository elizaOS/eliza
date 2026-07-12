# Eliza Hub Readiness

## Current Status

This repo is ready as a polished internal demo and handoff artifact for Eliza team discussion.

It includes:

- Eliza-branded Forgejo customization using the real Eliza logo and favicon.
- Dark default theme based on the current Eliza frontend style: black/white chrome, Poppins, 3px radius, and restrained `#FF5800` accents.
- Optional `eliza-light` theme.
- Local Poppins font assets so the theme does not depend on remote font loading.
- Eliza project board, merge queue, merge train plan, queue-item action plans, repo search, queue simulation, agent insights, agent capacity, agent performance, agent routing, agent bootstrap, agent work context, agent cockpit, agent action plan, agent submission gate, work preflight, work reservation, claim transfer, claim-assignment, claim-next, Eliza Work saved views, saved-view evaluation, work dashboards, work intake, and agent inbox APIs that group workflow cards into Kanban columns, merge lanes, owner-agent rows, planner-backed batch eligibility with skipped-candidate reasons, stacked PR dependency diagnostics and queue enforcement, read-only train execution contracts with live-execution preflight checks, PR-scoped next-step packets, natural-query repo context search, read-only proposed-PR enqueue previews, queue-to-work automation previews, opt-in and production-gated per-agent branch namespace and signed run receipt enforcement, ranked risk routing, startup policy snapshots, one-call resume packets, one-call cockpit packets, composed next-action plans, pre-submit overload control, pre-branch conflict checks with split-plan guidance, durable planning filters, evaluated Kanban/list payloads, durable leases, explicit handoff, and owner-specific next-action feeds.
- Agent submission gate budget checks that reject broad validation commands
  before a new agent PR is opened or shared runner capacity is consumed.
- Agent submission gate queue-depth checks that throttle one agent from
  flooding the queue with more open PRs while existing work is still in flight.
- Agent submission gate recent-submission rate checks that throttle bursty
  agent PR creation before queue depth alone can catch the flood.
- Agent bootstrap policy hints expose queue-depth, merge-train preflight, and
  recent-submission thresholds so agents can self-throttle before creating PRs.
- Agent action plans compose bootstrap, inbox, routing, repo search, work
  preflight, validation budget, submission gate, conflict prediction, and
  review assignment into one read-only next-action response for agents.
- Agent submission gate reservation checks that warn on unreserved proposed files
  and packages, with strict `requireWorkReservation` mode for controllers that
  want no-reservation, no-PR enforcement.
- PR briefs include work-reservation, queue-depth, and submission-rate coverage
  from the submission gate, so missing file/package reservations, queue flood
  blockers, and rate-limit blockers show up in review evidence, suggested
  actions, and `reservation:*`/`queue:*`/`rate:*` labels, with strict
  `requireWorkReservation` mode available for review-blocking briefs.
- Merge queue policy can require covered work reservations for agent PRs with
  `MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true`, blocking
  scheduling, planning, and worker claims until reservations cover the PR.
- Merge queue policy can require durable Eliza Work item links for agent PRs
  with `MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true`, blocking
  scheduling, planning, and worker claims until the PR, task, or issue links to
  an active Work item owned by the same agent.
- Merge queue policy can require agent PR source branches to live under the
  submitting agent namespace with
  `MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true`, blocking preflight,
  submission gates, queue scheduling, and live merge claims for unowned
  branches before agents spend runner capacity.
- Merge queue policy can require signed Eliza agent run receipts with
  `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true`, blocking agent PRs
  with missing, unsigned, stale, unhealthy, or failed run provenance before live
  merge execution.
- Merge queue policy can require agent owners to be in the allowed identity
  registry with `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` and
  `MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` plus the steward-managed
  `/api/agent-identities` registry, blocking unregistered agent PRs and OIDC
  claim mutations before live merge execution.
- CI failure analysis API that classifies noisy Actions logs into agent-routable
  categories, evidence lines, retryability, severity, and next actions.
- Repo search API that ranks steward PR, queue, run, claim, approval,
  human-request, and signal state plus supplied issue, diff, or Actions-log
  documents for natural query text.
- CI validation-plan API that blocks broad Turbo/typecheck/build commands by
  default and recommends package-scoped validation before agents consume shared
  runner capacity.
- PR review brief API that turns queue items into merge decisions, risk areas,
  validation-budget blockers, scoped replacement commands, verification gaps,
  commit-hygiene rollup requirements, reviewer hints, suggested actions, and
  agent-readable labels.
- Review assignment API that ranks non-author reviewer agents from changed
  paths, affected packages, active claims, current capacity, and performance
  evidence, with maintainer review hints for sensitive paths.
- Patch conflict prediction and work preflight APIs that score proposed
  files/packages against active claims, durable Work item overlap, queued PR
  overlaps, hot lanes, migrations, and lockfiles before agents reserve work or
  open PRs.
- Work reservation API that turns a clean preflight into durable path/package
  claim leases and a linked Eliza Work item before agents spend runner time or
  open PRs.
- Release-notes API that turns merged queue items or supplied PR facts into
  grouped Markdown drafts with agent, package, risk, and exclusion summaries.
- Private-network agent discovery manifest for Eliza Cloud and agent clients to locate OpenAPI, auth mode, route templates, and supported agent-native capabilities.
- Machine-readable GitHub/Forgejo/Eliza parity matrix at `GET /api/github-parity`,
  linked from discovery and deployment-doctor checked, so clients can tell
  which surfaces are Forgejo-native, Eliza-computed, steward-owned, partial,
  delegated, planned, or unsupported. Every surface includes cutover blocker
  status, required production evidence paths, required production gate checks,
  evidence-scored cutover readiness, migration targets, target APIs, and next
  actions so Eliza Cloud can decide migration readiness without guessing.
  Operators can run `eliza-merge-steward github-parity [--strict]` against the
  private production evidence bundle to fail the cutover if any blocking surface
  is still missing proof.
- Machine-readable production readiness checklist at
  `GET /api/production-readiness`, linked from discovery and
  deployment-doctor checked, so operators, Eliza Cloud, and agents can see the
  private evidence blocks, helper scripts, ordered helper steps,
  production-gate checks, and next actions still blocking launch.
- Machine-readable OpenAPI 3.1 contract for the Merge Steward product, agent coordination, runtime, claim, queue, policy, integration, and webhook APIs.
- Exported Merge Steward client for Eliza Cloud and agent runtimes with discovery, OpenAPI, dashboard views, Eliza Work saved views and view evaluation, parity, queue simulation, agent bootstrap/cockpit/routing/submission/inbox, approvals, human requests, signals, claims, repo policy, run, attempt, queue, comment, and webhook helpers.
- Merge Steward private runtime with policy scoring, signed Forgejo webhook ingestion, optional read-only Forgejo enrichment, queue read APIs, coordination summary API, guarded integration execution boundary, JSON and Postgres-backed state, run/node/attempt records, human approvals, human requests, external signals, agent work claim leases, OIDC-capable API auth, migration runner, guarded final Forgejo merge execution, opt-in dry-run Forgejo feedback mirroring, and tests.
- Durable Merge Steward `run-once` worker path that claims one ready PR or one safe merge train, creates run/node/attempt records, executes integration, and marks each queue item plus run succeeded, failed, or requeued.
- Opt-in Merge Steward worker loop guarded by explicit live-execution confirmation, durable worker lease ownership, lane-scoped Postgres claim locks, and stale active-item recovery.
- Prometheus-compatible Merge Steward metrics for readiness, queue depth, run state, attempts, claims, strict work-reservation posture, strict Work-item posture, strict branch namespace posture, signed run receipt posture, agent performance, routing health, and worker leases.
- Deployment doctor CLI that verifies `/health`, `/ready`, discovery, OpenAPI, runtime preflight, strict work-reservation, strict Work-item, branch namespace, signed run receipt posture, and allowed-agent identity registry posture for live integration, worker lease readiness, required metrics, and workflow/GitHub parity/production readiness/board/merge queue diagnostics/merge train/search/queue simulation/agent identities/release-readiness/repository-protection/insights/agents/performance/routing/fleet coordination/work context/bootstrap/cockpit/action plan/submission gate/work preflight/work reservation/work views/work view evaluation/work pages/work dashboard/work intake/CI failure analysis/validation plan/PR brief/review assignment/patch conflict prediction/inbox API smoke before traffic cutover.
- Hetzner staging backup and non-destructive restore-check scripts, age-encrypted
  rclone upload with streamed remote SHA-256 verification, isolated off-site
  recovery validation, and a fail-closed systemd timer entry point.
- Hetzner staging disposable Postgres restore-drill script that restores a
  backup dump, runs steward migrations, and verifies runtime tables without
  touching the live Compose stack.
- Hetzner staging Prometheus scrape config and Merge Steward alert rules.
- Hetzner staging post-deploy verifier for read-only compose, health, readiness, discovery, OpenAPI, workflow/GitHub parity/production readiness/board/merge queue diagnostics/merge train/search/queue simulation/agent identities/release-readiness/repository-protection/insights/agents/performance/routing/fleet coordination/work context/bootstrap/cockpit/action plan/submission gate/work preflight/work reservation/work views/work view evaluation/work pages/work dashboard/work intake/CI failure analysis/validation plan/PR brief/review assignment/patch conflict prediction/inbox API smoke, metrics, doctor, safe merge queue rollout drill, and Prometheus checks.
- Hetzner staging isolated Forgejo Actions runner scaffold using Docker-in-Docker instead of the host Docker socket.
- Hetzner staging private env validator for placeholders, missing secrets, bind exposure, and runner/steward safety contradictions.
- Hetzner staging Caddy reverse-proxy template for TLS, Forgejo root routing,
  and Merge Steward `/steward` base-path routing.
- Pinned Hetzner and Cloudflare Terraform stack for a protected dedicated host,
  retained static IPv4, firewall, separate web and native Git SSH records,
  direct Caddy TLS by default, optional edge-restricted Cloudflare web proxying
  after upload-limit review, hardened cloud-init, and private R2-compatible
  remote state, plus non-mutating infrastructure validation in the release
  gate and Forgejo CI.
- Hetzner staging host preflight for read-only Docker Compose, TLS proxy,
  toolchain, optional DNS, and loopback port checks before deploy.
- Hetzner staging Forgejo SMTP configuration is env-driven and validated when
  mail is enabled, while default private-demo mail stays disabled.
- Hetzner staging release gate plus release and rollback runbook.
- Evidence-driven production gate CLI that fails closed until private launch
  evidence proves domain/TLS, timestamped SSO smoke provenance, backup restore,
  Postgres migration with retained database audit/log provenance,
  digest-pinned image provenance with retained audit artifact provenance,
  runner isolation, protected branches, secret management, mail, storage,
  observability, steward readiness, merge-queue rollout, security review, and
  fresh launch timestamps.
- Domain evidence CLI that probes the live Forgejo HTTPS root and produces the
  production-gate `domain` block while preserving explicit reverse-proxy review.
- SSO evidence CLI that converts private Eliza Cloud OIDC config, locked
  registration config, and structured live human, agent, service, and
  recovery-admin smoke results into the production-gate `sso` block with
  local artifact provenance, without printing OIDC secrets.
- Backup evidence CLI that verifies a backup bundle checksum manifest, reads
  backup timing, infers covered components, and re-verifies linked off-site
  upload and recovery receipts before producing the production-gate `backups`
  block with retained source and audit SHA-256 provenance.
- Database evidence CLI that converts Forgejo/Postgres Compose wiring, steward
  Postgres config, migration output, and restore-drill output into the
  production-gate `database` block with retained audit, migration-log, and
  restore-drill-log provenance, without printing database URLs.
- Steward evidence CLI that sanitizes production preflight and deployment
  doctor JSON plus runtime provenance, label-mirroring, and bot-token review
  attestations into the production-gate `steward` block.
- Merge queue rollout evidence CLI that converts dry-run, staged live drill,
  worker lease, strict work-reservation, strict Work-item, branch namespace, signed run receipt,
  stack dependency ordering, rollback drill, and human approval attestations
  into the production-gate `mergeQueueRollout` block with artifact provenance
  summaries and SHA-256 digests.
- Safe merge queue rollout drill that verifies steward readiness, deployment
  doctor, non-mutating integration planning, and unconfirmed execution gates
  before live worker execution is enabled.
- Security review evidence CLI that converts auth, token, runner execution,
  repo permission, reviewer, and timestamp attestations into the
  production-gate `securityReview` block with retained local audit artifact
  provenance.
- Secret management evidence CLI that converts private env state plus
  external-secret-store and rotation-policy attestations into the
  production-gate `secrets` block with retained local audit artifact
  provenance, without sourcing `.env` or printing secret values.
- Mail evidence CLI that converts private SMTP config plus invite,
  password-reset, and notification smoke-test attestations into the
  production-gate `mail` block with retained local audit artifact provenance,
  without printing SMTP credentials.
- Storage evidence CLI that converts private action retention settings plus
  sizing, package-retention, and LFS review attestations into the
  production-gate `storage` block with retained local audit artifact
  provenance.
- Observability evidence CLI that converts private Prometheus scrape, alert
  routing, log collection, retention, and page-alert attestations into the
  production-gate `observability` block with retained local audit artifact
  provenance.
- Production evidence assembler that merges generated domain, SSO, backup,
  database, image, runner, repository, GitHub migration rehearsal, secret,
  mail, storage, observability, steward, merge queue rollout, security review,
  applied deploy, and post-deploy receipt fragments into the private
  production evidence file.
- Repository protection evidence CLI that converts protected-branch and
  required-check policy plus retained live-audit artifact provenance and fork,
  Actions, and admin-bypass attestations into the production-gate `repository`
  block.
- JSON Schema and runtime shape validation for production evidence so editors,
  release tooling, and the production gate catch malformed launch evidence.
- Hetzner staging Forgejo identity bootstrap verifier for local recovery admin,
  Eliza Cloud OIDC auth-source drift, steward token ownership, and retained
  read-only bootstrap evidence.
- Merge Steward runtime preflight checks with a strict `production` deployment mode that fails startup when critical safety controls are missing.
- Docker packaging, Forgejo CI workflow scaffold, and Hetzner staging Compose templates for the steward.
- Forgejo CI now runs on every push and PR, installs from lockfile, runs
  steward checks/tests/audit, runs the repository privacy scan, builds the
  steward Docker image, parses staging scripts, lints shell scripts with ShellCheck, validates Prometheus
  config/rules with `promtool`, renders staging Compose, runs the read-only
  release gate with CI env evidence, and enforces runner isolation.
- Runner isolation audit CLI that converts rendered runner Compose/config plus
  private launch attestations into production-gate runner evidence.
- Private runner evidence helper that runs the live runner check, verifies the
  trusted smoke workflow through the Forgejo API, records operator review
  attestations, and immediately executes the runner-isolation audit.
- API-driven `runner-smoke` Forgejo Actions workflow validation for trusted
  isolated-runner launch before enabling agent PR traffic.
- Clean shareable config examples without live secrets, local database files, runner tokens, or passwords.

## Demo-Ready

Use this for:

- Showing the Eliza team what an agent-owned Git forge could feel like.
- Discussing migration away from overloaded GitHub Actions queues.
- Testing repo mirrors, issues, pull requests, projects, and Forgejo Actions in a controlled environment.
- Iterating on agent-specific Git ownership and Kanban workflow conventions.

## Not Yet Production-Ready

Before using this for Eliza Cloud or real team infrastructure, do a production pass for:

- Domain, TLS, reverse proxy, and canonical `ROOT_URL`.
- Invite policy and completed SSO smoke testing with real Eliza Cloud users,
  agent service identities, and steward service credentials,
  then a generated `sso` evidence block from `sso-evidence.mjs` with retained
  smoke artifact provenance and read-only identity bootstrap receipt
  provenance.
- Apply and observe the prepared encrypted off-host backup timer against the
  real bucket, complete an independent recovery using the separately held age
  identity, then generate the `backups` evidence block from
  `backup-evidence.mjs` with retained upload, recovery, and audit provenance.
- Production Postgres instance for Forgejo and Merge Steward, plus a completed
  empty-host migration and restore drill, then a generated `database` evidence
  block from `database-evidence.mjs` with retained database audit and log
  artifact provenance.
- Live runner registration, trusted smoke workflow, egress review, and secret exposure review for the isolated Actions runner pool.
- A passing `scripts/runner-evidence.sh` run, then copying its generated
  `runner` production fragment with retained smoke and isolation audit artifact
  provenance into the private production evidence file.
- External secret issuance and rotation policy for app.ini, runner registration,
  OAuth, mail, and webhook tokens, then a generated `secrets` evidence block
  from `secret-management-evidence.mjs` with retained secret-management audit
  artifact provenance.
- Mail configuration for invites, password reset, and notifications, then a
  generated `mail` evidence block from `mail-evidence.mjs` with retained mail
  smoke audit artifact provenance.
- Storage sizing for mirrored repositories, packages, artifacts, logs, and LFS,
  then a generated `storage` evidence block from `storage-evidence.mjs` with
  retained storage retention audit artifact provenance.
- Alert routing and log retention, then a generated `observability` evidence
  block from `observability-evidence.mjs` with retained observability audit
  artifact provenance.
- Repository branch protection and required-check policy verified through the
  live steward audit, then a generated `repository` evidence block with
  `liveProtectionEvidence` from `repository-evidence.mjs --require-live`,
  including retained local audit artifact SHA-256 provenance.
- Applied private pilot bootstrap, then a generated `githubMigration` evidence
  block assembled from `eliza-hub-pilot-bootstrap-evidence.json`, proving the
  GitHub pull mirror, steward webhook, branch protection, repo policy, trusted
  agent identities, and pilot product surfaces were created or verified.
- Production Merge Steward deployment, label mirroring, Eliza Cloud OIDC issuer,
  steward dashboard, live bot-token permission review, and strict
  work-reservation enforcement, then a generated `steward` evidence block from
  `steward-evidence.mjs` with preflight and doctor provenance.
- Completed staged merge-queue rollout, then a generated `mergeQueueRollout`
  evidence block from `merge-queue-rollout-evidence.mjs`, including dry-run,
  live-drill, and stack-order provenance. Production release-gate mode re-reads
  retained local backup audit, database audit/log, image provenance, SSO,
  runner, repository, GitHub migration rehearsal, secret management, mail smoke,
  storage retention, observability, steward, rollout, and security review
  source artifacts before accepting the copied evidence summary.
- Completed launch security review, then a generated `securityReview` evidence
  block from `security-review-evidence.mjs` with retained security review audit
  artifact provenance.
- Applied first-boot or rolling deploy receipt plus retained post-deploy
  verifier receipt, then a generated `deployment` evidence block assembled from
  `$ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json`. Production release-gate
  mode re-reads both receipt files before traffic cutover or live agent merges.
- `MERGE_STEWARD_DEPLOYMENT_MODE=production` with green `/ready` output on the deployed service.
- A passing `eliza-merge-steward production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"`
  result backed by private evidence, not checked-in placeholder data. Start from
  the schema-backed release template, verify generated private evidence
  fragments with `production-evidence-inventory.mjs --strict`, assemble them
  with `production-evidence-assemble.mjs`, and confirm
  `evidenceShape.ok`, `production_evidence_artifacts`, and
  `production_evidence_freshness` are all true.

## Recommended Next Step

Review and apply the dedicated-host Terraform plan for an approved private
staging hostname, wait for cloud-init, then run the host preflight and first-boot
Compose deployment. Mirror `elizaOS/eliza`, add the steward webhook after
creating a narrow Forgejo bot token and private webhook secret, and keep Actions
limited to trusted smoke jobs until the isolated runner evidence passes.
