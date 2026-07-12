# Isolated Actions Runner

This directory contains the private staging runner scaffold for Forgejo Actions.
It is intentionally separate from the local host-runner proof of concept.

## Model

- `actions-runner` runs Forgejo Runner.
- `actions-dind` runs a separate Docker-in-Docker daemon.
- Workflow job containers are created inside `actions-dind`, not on the host
  Docker daemon.
- Runner capacity is `1` by default so concurrent jobs cannot inspect each
  other through the shared DIND daemon.
- No `:host` labels are configured for staging.
- The host Docker socket is not mounted into any runner container.

This is still remote code execution. Keep this pool private, use a narrow
registration scope, avoid privileged workflow containers, and run untrusted PR
jobs only after branch protection, required checks, secret exposure, and runner
egress policy are reviewed.

## Files

- `config.example.yml` is the runner config template.
- `data/` is the private runtime directory for `config.yml`, `.runner`, and
  runner work state. Its contents are ignored except for `.gitkeep`.

## Register

On the staging host:

```bash
cp deployment/hetzner-staging/runner/config.example.yml deployment/hetzner-staging/runner/data/config.yml
FORGEJO_RUNNER_REGISTRATION_TOKEN=... \
deployment/hetzner-staging/scripts/register-actions-runner.sh
```

The registration token comes from Forgejo's Actions runner registration UI.
Prefer a repository or organization runner scope for staging rather than an
instance-wide runner.

## Start

```bash
docker compose \
  --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  -f deployment/hetzner-staging/compose.actions-runner.yml \
  --profile steward \
  --profile actions-runner \
  up -d actions-dind actions-runner
```

## Verify

```bash
deployment/hetzner-staging/scripts/check-actions-runner.sh
deployment/hetzner-staging/scripts/post-deploy-check.sh
```

Then run a trusted smoke workflow with `runs-on: docker` before allowing agent
PR traffic onto the runner pool. `runner-evidence.sh` verifies the passing
`.forgejo/workflows/runner-smoke.yml` run through the Forgejo API and records
that live result in the private runner evidence file.

Generate that private evidence and immediately run the Merge Steward isolation
audit:

```bash
RUNNER_SMOKE_DISPATCH=true \
RUNNER_EGRESS_REVIEWED=true \
RUNNER_SECRET_EXPOSURE_REVIEWED=true \
deployment/hetzner-staging/scripts/runner-evidence.sh
```

Leave `RUNNER_SMOKE_DISPATCH` unset to verify the latest passing trusted smoke
run without triggering a new workflow.

Copy the generated `runner` object from
`$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-production-evidence.json` into the private
production evidence file. Keep the referenced runner smoke and isolation audit
JSON files available until the production gate has passed.
