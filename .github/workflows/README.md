# GitHub Actions

The repository intentionally keeps a small workflow surface. Product behavior
belongs in package scripts; workflow YAML supplies triggers, credentials,
runners, environments, and a concise job graph.

## Required validation

`ci.yml` is the only pull-request workflow. It classifies changed paths, runs
repository quality checks, affected tests, deterministic smoke tests, a
path-scoped Android release AAB audit, and a diff-scoped secret scan. Branch
rules require only the stable `CI / Required` job. Individual jobs remain
visible for diagnosis but are not separately wired into branch protection.

`nightly.yml` calls the same CI workflow once per day and adds macOS and Windows
core smoke tests. It never publishes packages or creates releases.

## Manual operations

- `live-smoke.yml` is the only credential-backed integration-test entry point.
- `release.yaml` is the only package/tag/GitHub Release entry point.
- `infra.yml` is the only Terraform plan, apply, and state-edit entry point.
- `voice-code-bench.yml` retains the bounded real-ASR benchmark.

These workflows use `workflow_dispatch` and never run for pull requests.

## Deployments

Path-scoped deployment workflows may run after changes land on `develop` or
`main`. They do not create pull-request checks. GitHub environments own
production approvals and credentials.

## Maintenance and assistance

`weekly-maintenance.yml` provides the single scheduled dependency/security
maintenance signal. `claude.yml` remains opt-in through mentions and is not a
required check.

When adding automation, prefer extending an existing package script and one of
these workflows. A new workflow requires a distinct trigger, credential, runner,
or environment boundary that cannot be represented as another job or dispatch
choice.
