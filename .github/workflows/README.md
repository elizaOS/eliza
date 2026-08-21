# GitHub Actions

The repository intentionally keeps a small workflow surface. Product behavior
belongs in package scripts; workflow YAML supplies triggers, credentials,
runners, environments, and a concise job graph.

## Required validation

`ci.yml` is the canonical pull-request, merge-queue, and `develop` branch-health
workflow. Pull requests targeting `develop` or `main` and every `merge_group`
candidate run the same fail-closed job graph. Branch rules require only its stable
`CI / All Tests Passed` aggregate, which succeeds only when every mandatory lane
succeeds; individual lane names may evolve without silently weakening admission.

`merge-candidate-biome.yml` remains a defense-in-depth merge-queue check of
GitHub's synthesized candidate tree. It runs the repository-pinned full lint and
format contracts, but it is not a separately required context because canonical
CI already covers those contracts and publishes the single admission aggregate.

`.github/rulesets/required-branches.json` is the reviewed no-bypass ruleset
manifest for `develop` and `main`. `scripts/security/apply-branch-protection.sh`
is read-only by default (`--check`) and requires explicit `--apply` authority to
create or update that exact ruleset. `repository-ruleset-drift.yml` performs the
same semantic readback on a schedule, by manual dispatch, and through the
`repository_ruleset_drift` external repository-dispatch event. A green readback
proves configuration parity only; owner audit-log review plus red/green and
direct-push canaries remain required after an authorized apply. Scheduled and
external readback requires an owner-provisioned
`REPOSITORY_RULESET_READ_TOKEN` Actions secret with repository
`Administration: read`; the workflow-scoped `GITHUB_TOKEN` cannot request
that repository permission and is never used for this readback.

The manifest intentionally keeps Code Owner review disabled while
`.github/CODEOWNERS` names placeholder teams. An organization owner must
replace every placeholder, verify each team exists and can review the covered
paths, then submit a separate reviewed manifest change enabling Code Owner
review. The current ruleset still requires one approval, last-push approval,
and review-thread resolution.

The manifest allows squash and rebase only: linear history rejects merge commits.
Required-signature enforcement is deferred because GitHub cannot generally
produce a signed web squash for an external contributor unless the merger is
also the pull-request author, while rebase admission requires every source
commit to be signed. An owner may propose signature enforcement separately only
after proving contributor-safe signed squash/rebase canaries; ordinary approval,
last-push approval, thread resolution, status checks, linear history, and the
force-push/deletion bans remain active here.

`nightly.yml` calls the same CI workflow once per day and adds macOS and Windows
core smoke tests. It never publishes packages or creates releases.

`develop-health.yml` is the canonical uncontended trunk-health lane (#19181).
Push-triggered develop runs supersede each other during merge waves, so this
lane runs the repository verify gate on the live develop tip four times a day
(and on manual dispatch) from a single hosted runner, in a fixed
never-cancelled concurrency group, and publishes the outcome as a
`develop-health` commit status on the exact SHA it measured. A missing status
means no measurement concluded; a red status means develop is actually red —
the lane exists to keep those two states distinguishable while the fleet is
saturated.
[![develop health](https://github.com/elizaOS/eliza/actions/workflows/develop-health.yml/badge.svg?branch=develop)](https://github.com/elizaOS/eliza/actions/workflows/develop-health.yml)

## Scheduled security analysis

`codeql.yml` runs JavaScript/TypeScript CodeQL analysis only on its weekly
schedule or by explicit manual dispatch. It deliberately has no `push` or
`pull_request` trigger, so CodeQL cannot add work or checks to ordinary pull
request updates. Seven category-distinct production shards keep the default
security suite inside hosted-job limits while covering every maintained package,
plugin, product, cloud, and operational script root. Generated, vendored, test,
fixture, research, example, and documentation trees are excluded.

## Specialized pull-request checks

Several branch-scoped and path-scoped workflows run alongside the canonical CI
gate for specific surfaces. This list is non-exhaustive; other specialized
gates such as `cloud-tests.yml`, `chat-shell-gestures.yml`, and the `pr.yaml`
title check cover narrower contracts. None replaces the required
`All Tests Passed` aggregate.
Representative examples:

- `develop-pr.yml` is called from canonical `ci.yml` for `develop`-targeted PRs
  and runs lint, typecheck, build, changed-plugin tests, and pinned `actionlint`.
  It has no direct pull-request trigger, so outside contributors encounter only
  the canonical workflow's approval boundary.
- `gitleaks.yml` scans protected-branch pushes. Canonical `ci.yml` owns the
  equivalent diff-scoped pull-request secret scan on a hosted runner.
- `quality.yml` supplies the extended homepage build and workspace format gate
  for `main`-targeted PRs and post-merge pushes, including the single
  `packages/app` frontend artifact and embedded homepage source contracts.
- `scenario-pr.yml` supplies the opt-in scenario-runner and browser matrix for
  `main`-targeted PRs carrying the `ci:full` label.
- `ui-e2e-gate.yml` and `ui-fixture-e2e.yml` run the packages/ui Chromium and
  WebKit fixture gates when `packages/ui/src/**` changes.
- `device-e2e.yml` is the exact-head Android-emulator and iOS-simulator
  device-bundle producer (#19640). Canonical `ci.yml` calls it only for PRs
  carrying the `ci:device` label; `workflow_dispatch` is the on-demand route,
  and a weekly cadence hard-gates only the explicit host-safe Android subset;
  scheduled runs do not allocate the macOS/iOS job. A scheduled Android
  non-success opens, updates, or reopens one stable failure issue containing
  exact run-attempt, attempt-scoped artifact, and revision links; the next
  successful cadence updates and closes it so the issue never remains stale.
  The notifier has job-scoped read access to Actions and contents plus issue
  write access; reusable and manually dispatched runs never write issues.
  [![scheduled device e2e](https://github.com/elizaOS/eliza/actions/workflows/device-e2e.yml/badge.svg?branch=develop&event=schedule)](https://github.com/elizaOS/eliza/actions/workflows/device-e2e.yml?query=event%3Aschedule)
  Artifact names include the run ID and attempt so reruns cannot overwrite or
  link a prior attempt's bundle. Both jobs initialize a revision-bound artifact
  root after checkout, then run the bundle-owning runners with `--output`. A
  started runner finalizes the full bundle (`inline/`, `logs/`, `summary.json`,
  `junit.xml`) on success and failure; an earlier toolchain or device failure
  retains the bootstrap record plus the Actions log. No job reads a repository
  secret.
- `android-arm64-local-e2e.yml` is the separate weekly, schedule-only
  self-hosted physical-device lane for the embedded Bun + GGUF agent. Its
  `[self-hosted, Linux, ARM64, android-device]` labels are an infrastructure
  contract: the job stays queued until such a runner is online, then fails
  closed unless both the host and attached Android target pass ARM64 and pinned
  toolchain preflight. Preflight output is uploaded even when a prerequisite
  fails before the bundle runner starts. It runs local chat plus
  local-runtime/route WebView probes; on-device voice remains separately
  qualified. Manual arbitrary-ref dispatch is intentionally unavailable
  because this runner persists and owns a physical device.

## Manual operations

- `live-smoke.yml` is the general credential-backed dispatcher. Its input
  selects `app`, `scenarios`, `live-information`, `cloud`, `voice`,
  `dedicated`, or `all`. The `live-information` route runs the focused current
  information matrix against the selected OpenAI, Anthropic, or OpenRouter
  planner with an independent judge requirement, a five-minute per-turn budget,
  and an always-uploaded evidence bundle. The
  `dedicated` suite owns the managed dedicated staging canary and exact
  stale-canary recovery. Specialized app and voice evidence also flows through
  `app-live-e2e.yml` and `voice-live-e2e.yml`, which run on schedule or
  dispatch.
- `release.yaml` is the npm, canonical Git tag, and GitHub Release authority.
  It creates the release as the final step of its npm/version transaction.
  The stable tag then triggers `release-electrobun.yml`, which resolves and
  checks out the peeled tag commit, verifies the existing release is bound to
  that commit, and uploads signed desktop assets without creating or replacing
  the release. Because branch protection does not cover tags, the workflow
  also requires the tagged commit to be an ancestor of `main` or `develop`
  and gates every signing, release-upload, and OTA-publish job behind the
  reviewer-approved `production-release` environment; a tag protection
  ruleset restricting `v*` creation completes that boundary.
  After finalization, the canonical workflow also calls the reusable,
  callable-only `snap-publish.yml` and `store-mobile-publish.yml` legs with the
  exact finalized source SHA, version, channel, and tag. Those legs re-resolve
  the tag to the supplied commit before using credentials and run behind the
  `production-release` environment. Snap uploads the registered `eliza` name;
  Android builds and audits the cloud-only AAB before Google Play upload; iOS
  embeds the store runtime and uses an App Store Connect API key for signing
  and delivery. Missing credentials fail the affected store job with the exact
  secret names instead of silently skipping publication.

  Store credentials are environment-owned. Snap needs
  `SNAPCRAFT_STORE_CREDENTIALS`. Google Play needs the four
  `ANDROID_KEYSTORE_*` secrets plus `PLAY_STORE_SERVICE_ACCOUNT_JSON` (raw
  service-account JSON or its base64 encoding). Apple
  needs `APPLE_ID`, `APPLE_TEAM_ID`, `ITC_TEAM_ID`, `APP_STORE_APP_ID`, the
  three `MATCH_*` values, and `APP_STORE_API_KEY_ID`,
  `APP_STORE_API_ISSUER_ID`, and `APP_STORE_API_KEY_P8`. The API-backed first
  upload still depends on the corresponding organization account, application
  record, agreements, and roles already existing in each publisher portal.

  The authored inventory of those names, together with the prerequisite,
  owner, rotation cadence, and revocation path for each lane, lives in
  `packages/scripts/lib/store-release-credentials.mjs`.
  `bun run release:store-credentials` prints it and fails on drift between the
  contract and the names these workflows reference.
  `bun run release:store-credentials:audit` additionally reads the live
  `production-release` environment through `gh api` and lists what a repository
  owner still has to provision. Both operations compare names only; the GitHub
  API never exposes secret values and the preflight never reads, prints, or
  stores one. Exit codes are `0` ready, `1` contract drift or unreadable live
  state, `2` live environment not yet provisioned.

  Creating `production-release`, selecting its required reviewers and
  deployment branch/tag policy, and adding any credential are owner-only
  actions taken in the GitHub UI with authorized confirmation at action time.
  No automation in this repository creates them.
- `infra.yml` is the only Terraform plan, apply, and state-edit entry point.
  Each protected Environment supplies a distinct RSA public-key variable
  `TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY` and apply-only private-key secret
  `TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY`. Plan runs wrap a fresh AES-256-GCM key
  with RSA-OAEP, encrypt the saved plan before it leaves the runner, and
  authenticate its review metadata. An apply requires the exact plan run id,
  run attempt, GitHub artifact id, and GitHub service digest shown in the plan
  summary; it downloads by artifact id, decrypts only after every identity
  check, and never creates a replacement plan. Plaintext plan files are
  shredded on every plan/apply outcome.
- `arm-headscale-control-plane.yml` is the protected Hetzner Headscale
  convergence path. Its default operation converges the environment-fixed
  canonical/legacy overlap. Staging additionally exposes a read-only inspection
  of the exact reviewed `/etc/nginx/conf.d/headscale-staging.conf` artifact and
  a separate explicit retirement operation. The latter validates the regular
  root-owned legacy-only two-listener contract, requires the exact SHA-256
  emitted by the reviewed inspection, backs up both nginx files, and
  restores them on any ownership, SAN, nginx, reload, public-health, router,
  environment-write, worker-restart, or final service-liveness failure.
  Production has no legacy-file cleanup path.
- `deploy-tunnel-proxy.yml` is the protected Railway + Headscale convergence
  path for the customer tunnel proxy. It validates canonical staging/production
  hosts, rotates the reusable `tag:eliza-proxy` enrollment key without logging
  it, deploys the service, and verifies Railway domain/TLS state plus live
  unsigned-host rejection. Cloudflare DNS is a separate credential boundary:
  a first run may attach the domains and then stop while an operator copies the
  returned records into `RAILWAY_TUNNEL_DNS_RECORDS_JSON` and applies the
  `pages-domains` Terraform plan. That root owns the exact provider-generated
  CNAME/TXT values as DNS-only records and imports existing records only by
  reviewed Cloudflare id.
- `deploy-gateway-webhook.yml` is the protected Railway release path for the
  multi-platform webhook gateway. Staging dispatches must select `develop` and
  production dispatches must select `main`. The workflow validates the exact
  protected Railway project, environment, service, and public URL; uploads the
  exact dispatch SHA from the repository root with a byte-identical root copy
  of the tracked service `railway.toml`; follows the returned deployment id to
  success; proves that exact id remains active around the public probes; and
  verifies the applied Dockerfile/health manifest, live health, and canonical
  cloud/agent fallback routing pair. A successful release publishes a
  source/environment/deployment-id receipt; the protected edge-activation
  workflow downloads that exact run receipt, revalidates the active Railway
  deployment before and after its probes and edge mutation, and shares this
  workflow's per-environment concurrency key so gateway releases, canonical
  Cloudflare releases, and cutovers cannot race. Protected-environment approval
  completes before any of those jobs enters the shared mutation lock. It also
  sends a headerless `GET` to the
  dedicated `/ready/forwarder-auth/eliza-app` contract and requires the exact
  enforced-gate 401 response before reasserting the active deployment. A
  disabled secret or mismatched forwarded project produces a distinct non-401
  readiness failure; the probe never enters provider or message handling and
  refuses supplied forwarder-secret headers without comparing them. Configure
  environment variables
  `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
  `RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK`, and
  `ELIZA_APP_WEBHOOK_GATEWAY_URL`, with `RAILWAY_TOKEN` as an environment
  secret. Existing sensitive service values stay in Railway and are checked by
  name without being printed or rewritten, including the required
  `ELIZA_APP_WEBHOOK_GATEWAY_SECRET` BFF-forwarding trust gate. Staging is
  protected by the workflow's exact `develop` branch and environment-scoped
  configuration gates but does not currently require a reviewer; production
  retains its required-reviewer approval.

  The dispatch choice and selected GitHub Environment use the same exact name;
  Railway service names are separate targets:

  | Dispatch / GitHub Environment | Source branch | Railway service |
  | --- | --- | --- |
  | `staging` | `develop` | `gateway-webhook-stg` |
  | `production` | `main` | `gateway-webhook` |

  The pinned Railway CLI is invoked without a relative path so its explicit
  project selector archives the absolute current repository root. Passing `.`
  with Railway CLI v5.38.0 fails its pre-upload archive-prefix check.
- `voice-code-bench.yml` retains the bounded real-ASR benchmark.

These workflows use `workflow_dispatch` and never run for pull requests.

## Deployments

Path-scoped deployment workflows may run after changes land on `develop` or
`main`. They do not create pull-request checks. GitHub environments own
production approvals and credentials.

`cloud-cf-deploy.yml` and `build-agent-image.yml` cover the runtime workspace
dependency closure of their release artifacts, not only their owning
directories. Keep that source admission synchronized with package manifests
through `cloud-release-dependency-trigger-workflow.test.ts`; otherwise a
source-form package can change an artifact without creating a release
candidate.

Production Cloud admission is also tree-bound to staging. A staging release
whose run SHA the `develop` head has fast-forwarded past ends neutrally before
any mutation only when GitHub proves that an active Cloud CF Deploy push run
exists for the exact new head (the canonical-source guard reports
`superseded=true`, every deploy job skips, and no certification is uploaded).
Ancestry without a successor run, production staleness, divergence, or any
unverifiable source still fails the run. After every successful, non-superseded
automatic `develop` Cloud release, `cloud-cf-deploy.yml` uploads a
14-day immutable certification whose JSON names the repository, workflow,
source SHA, root Git tree, run/attempt, environment, and deterministic artifact
name. A production dispatch checks out the exact requested `main` SHA and must
resolve that tree's non-expired artifact from a completed successful
`push`/`develop` run before the protected `production` approval job is even
reachable. The artifact id, GitHub digest, owning run, payload, current workflow
bytes, and expiry are all checked. Different merge commits are accepted only
when their root trees are byte-identical; `force` never bypasses this gate.

Cloudflare application deploys require Workers and Pages write access. The
Terraform domain workflow additionally requires zone-scoped DNS write and
`SSL and Certificates Write` access because it manages advanced wildcard
certificate packs. Prefer separate environment-scoped deploy and DNS/TLS
tokens so staging automation cannot mutate production zones.

Cloudflare secret values are write-only and cannot be reconstructed into
GitHub. Deploy workflows therefore publish shared Worker/control-plane secrets
only when the selected protected environment explicitly supplies a value. When
GitHub is blank, the live Worker or host value is preserved; names-only
post-deploy inventories fail closed if a required binding is absent. This proves
presence, not byte-for-byte parity, so parity still requires an intentional
rotation to one newly generated environment-owned value.

The protected `TUNNEL_HOSTNAME_SIGNING_SECRET` is intentionally shared by the
Cloud Worker and Railway tunnel proxy. Configure one environment-owned value
per environment; `cloud-cf-deploy.yml` publishes it to the Worker and
`deploy-tunnel-proxy.yml` publishes the same value to Railway. Neither workflow
reads a value back from a provider.

## Maintenance and assistance

`weekly-maintenance.yml` provides the single scheduled dependency/security
maintenance signal. `claude.yml` remains opt-in through mentions and is not a
required check.

When adding automation, prefer extending an existing package script and one of
these workflows. A new workflow requires a distinct trigger, credential, runner,
or environment boundary that cannot be represented as another job or dispatch
choice.
