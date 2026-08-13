# GitHub Actions

The repository intentionally keeps a small workflow surface. Product behavior
belongs in package scripts; workflow YAML supplies triggers, credentials,
runners, environments, and a concise job graph.

## Required validation

`ci.yml` is the canonical required pull-request workflow for both `develop` and
`main`. It classifies changed paths, runs repository quality checks, affected
tests, deterministic smoke tests, a path-scoped Android release AAB audit, and a
diff-scoped secret scan. The stable `CI / Required` job is the only status
intended for branch protection. Individual jobs remain visible for diagnosis
but are not separately wired into protection rules.

`nightly.yml` calls the same CI workflow once per day and adds macOS and Windows
core smoke tests. It never publishes packages or creates releases.

## Specialized pull-request checks

Several branch-scoped and path-scoped workflows run alongside the canonical CI
gate for specific surfaces. This list is non-exhaustive; other specialized
gates such as `gitleaks.yml`, `cloud-tests.yml`, `chat-shell-gestures.yml`, and
the `pr.yaml` title check cover narrower contracts. None replaces the
`CI / Required` status. Representative examples:

- `develop-pr.yml` runs lint, typecheck, build, and changed-plugin tests for
  `develop`-targeted PRs. `actionlint` reaches merge-critical workflows through
  the pinned installer in `install-workflow-linters.sh`.
- `quality.yml` builds the single `packages/app` frontend artifact, validates
  the embedded homepage source contracts, and supplies the workspace format
  gate for `main`-targeted PRs and post-merge pushes.
- `scenario-pr.yml` supplies the opt-in scenario-runner and browser matrix for
  `main`-targeted PRs carrying the `ci:full` label.
- `ui-e2e-gate.yml` and `ui-fixture-e2e.yml` run the packages/ui Chromium and
  WebKit fixture gates when `packages/ui/src/**` changes.

## Manual operations

- `live-smoke.yml` is the general credential-backed dispatcher. Its input
  selects `app`, `scenarios`, `cloud`, `voice`, `dedicated`, or `all`. The
  `dedicated` suite owns the managed dedicated staging canary and exact
  stale-canary recovery. Specialized app and voice evidence also flows through
  `app-live-e2e.yml` and `voice-live-e2e.yml`, which run on schedule or
  dispatch.
- `release.yaml` is the npm, canonical Git tag, and GitHub Release authority.
  It creates the release as the final step of its npm/version transaction.
  The stable tag then triggers `release-electrobun.yml`, which resolves and
  checks out the peeled tag commit, verifies the existing release is bound to
  that commit, and uploads signed desktop assets without creating or replacing
  the release. `snap-publish.yml` owns Snap Store publication.
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
- `voice-code-bench.yml` retains the bounded real-ASR benchmark.

These workflows use `workflow_dispatch` and never run for pull requests.

## Deployments

Path-scoped deployment workflows may run after changes land on `develop` or
`main`. They do not create pull-request checks. GitHub environments own
production approvals and credentials.

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
