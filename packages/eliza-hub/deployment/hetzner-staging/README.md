# Hetzner Staging Scaffold

This directory is private staging scaffolding for a later Hetzner deployment. It is not a deployment record and does not contain secrets, production hostnames, live database state, runner tokens, or real OAuth credentials.

## Shape

- `postgres` stores Forgejo data and the steward database when the steward
  profile is enabled.
- `forgejo` runs the Git web app with the Eliza custom layer mounted read-only.
- `merge-steward-migrate` applies the steward Postgres migrations before the
  service starts.
- `merge-steward` is an optional production-strict profile for the Eliza Merge
  Steward service.
- Caddy or nginx should terminate TLS on the host and proxy to Forgejo on loopback.
- Forgejo Actions can be enabled, but runners are intentionally not included here.

The compose defaults bind Forgejo HTTP and SSH to `127.0.0.1`. Keep that default until host firewall, private DNS, TLS, backups, and runner isolation are explicitly handled.

## Files

- `compose.yml` defines the private staging service topology.
- `compose.actions-runner.yml` adds the isolated Forgejo Actions runner pool.
- `terraform/` declares the protected Hetzner host, static IPv4 address,
  firewall, Cloudflare web/SSH DNS records, R2 remote-state configuration, and
  hardened cloud-init bootstrap.
- `.env.example` lists required environment variables with blank secret values.
- `scripts/generate-private-env.sh` creates a gitignored local `.env` with
  generated secrets and safe loopback defaults for validation.
- `scripts/validate-env.sh` checks the private `.env` for placeholders, missing
  secrets, unsafe binds, and runner/steward contradictions.
- `scripts/host-preflight.sh` checks read-only host prerequisites before a
  staging deploy.
- `scripts/validate-infrastructure.sh` formats, initializes with the remote
  backend disabled, and validates Terraform without planning or applying.
- `scripts/bootstrap-forgejo-identity.sh` verifies or applies the Eliza Cloud
  OIDC auth source, recovery admin, and steward token owner.
- `scripts/merge-queue-rollout-drill.sh` runs a read-only merge queue rollout
  drill against a deployed steward before live merge execution is enabled.
- `pilot-bootstrap.md` documents the private first-repository bootstrap:
  mirror import, webhook, branch protection, runner smoke workflow, repo policy,
  agent identity registry, board checks, and merge queue gates.
- `scripts/backup.sh` creates a host-side backup bundle for Forgejo, Postgres,
  the Eliza custom layer, templates, and non-secret deployment metadata.
- `scripts/restore-check.sh` verifies a backup bundle before a restore drill.
- `scripts/backup-offsite.sh` encrypts a verified bundle with age, uploads it
  through rclone, and verifies the remote ciphertext by streamed SHA-256.
- `scripts/restore-offsite-check.sh` downloads and decrypts an off-site backup
  in an isolated recovery environment, rejects unsafe archive entries, and
  writes a recovery receipt.
- `scripts/run-scheduled-backup.sh` is the fail-closed, flock-protected entry
  point for the example systemd service and timer under `systemd/`.
- `scripts/post-deploy-check.sh` runs read-only host checks after staging deploy.
- `scripts/release-gate.sh` runs the read-only pre-release gate.
- `scripts/register-actions-runner.sh` registers the private Actions runner.
- `scripts/check-actions-runner.sh` verifies runner isolation after start.
- `runner/` contains the staging runner config template and ignored runtime data.
- `observability/` contains Prometheus scrape and alert examples for the steward.
- `reverse-proxy/` contains host-level TLS reverse-proxy templates.
- `release/` contains the staging release and rollback runbook.
- `../../templates/forgejo/app.staging.example.ini` is the equivalent app.ini template for operators who prefer a file-based config.
- `../../docs/eliza-cloud-sso-plan.md` covers the Eliza Cloud / Steward OIDC plan.

## Local Artifacts

Release and test helpers write private evidence and scratch output under
disk-backed roots by default:

```bash
export ELIZA_ARTIFACT_ROOT="${ELIZA_ARTIFACT_ROOT:-$HOME/.local/state/eliza-hub/artifacts}"
export ELIZA_TMP_ROOT="${ELIZA_TMP_ROOT:-$HOME/.cache/eliza-hub/tmp}"
mkdir -p "$ELIZA_ARTIFACT_ROOT" "$ELIZA_TMP_ROOT"
```

Use `ELIZA_ARTIFACT_ROOT` for evidence that must survive until the production
gate passes, and `ELIZA_TMP_ROOT` for disposable script output. Avoid `/tmp` on
developer machines where it is mounted as tmpfs; repeated evidence, Compose,
browser, or build artifacts there can consume RAM and force swap.

Safe cleanup is dry-run by default:

```bash
scripts/prune-local-artifacts.sh
APPLY_PRUNE=true PRUNE_MIN_AGE_DAYS=14 scripts/prune-local-artifacts.sh
```

The prune helper only operates inside the configured Eliza roots. External
browser profiles such as `/tmp/eliza-live-profiles` are intentionally not
deleted by this repo; verify no Chrome or Playwright process is using them
before removing those manually.

## Private Env Bootstrap

For local release-gate and Compose-render validation, generate a private
gitignored `.env`:

```bash
deployment/hetzner-staging/scripts/generate-private-env.sh
deployment/hetzner-staging/scripts/validate-env.sh
```

Set `FORCE=true` only when intentionally rotating the local generated file. The
generated values are sufficient for local validation but are not production
evidence. On a real staging host, replace the local defaults with the host
domain, approved image tags or digests, Eliza Cloud OIDC settings, and secrets
issued by the host secret store.

Host-side Bash helpers parse `.env` as simple `KEY=VALUE` data through
`scripts/env-loader.sh`; they do not source or execute the file. Keep private
env files to plain assignments, quote values that contain spaces, and avoid
shell syntax such as `export`, `source`, or command substitution.

## Later Host Setup

Provision a dedicated host from the Terraform stack when possible. Keep
account-specific IDs, public keys, hostnames, CIDRs, API tokens, and remote
state outside Git:

```bash
deployment/hetzner-staging/scripts/validate-infrastructure.sh
```

The infrastructure defaults to a CPX32 pilot host with Hetzner backup and
delete protection, key-only non-root administration, direct Caddy TLS through
Cloudflare-managed DNS, and native Forgejo SSH on a separate DNS-only hostname
and port. Cloudflare web proxying is opt-in after direct TLS and Git/LFS/package
upload limits are reviewed. Read
`terraform/README.md`, review a saved Terraform plan, and require zero deletes
or replacements before an ordinary apply. Terraform apply is a paid external
mutation and is never run by the repository release gate.

On the staging host, copy `.env.example` to a private `.env` file and fill it from the host secret store. Do not commit the filled file.

Required secret values:

- `FORGEJO_DB_PASSWORD`
- `FORGEJO_SECRET_KEY`
- `FORGEJO_INTERNAL_TOKEN`
- `FORGEJO_OAUTH2_JWT_SECRET`
- `FORGEJO_RECOVERY_ADMIN_PASSWORD`
- `FORGEJO_SMTP_PASSWORD`, only when `FORGEJO_MAIL_ENABLED=true`
- `ELIZA_CLOUD_FORGEJO_CLIENT_SECRET`
- `FORGEJO_STEWARD_TOKEN`, only when enabling the steward profile
- `FORGEJO_WEBHOOK_SECRET`, only when enabling the steward profile
- `MERGE_STEWARD_DATABASE_URL`, required when enabling the steward profile
- `MERGE_STEWARD_API_TOKEN`, kept as a private machine or break-glass token even
  though production steward control APIs require `MERGE_STEWARD_OIDC_ENABLED=true`
  with the Eliza Cloud issuer, discovery URL, allowed role/group gates, and admin
  role/group gates
- `MERGE_STEWARD_EVENT_GATE_REPOSITORIES`, set to the repos allowed to mutate
  steward queue state
- `FORGEJO_RUNNER_REGISTRATION_TOKEN`, only while registering a private Actions
  runner

Before first boot, choose approved images for `FORGEJO_IMAGE`,
`MERGE_STEWARD_IMAGE`, and `FORGEJO_RUNNER_IMAGE`. The committed image values
use `example.invalid` placeholders by design.

For Eliza Cloud sign-in, keep OAuth2 auto-registration enabled and public local
registration locked. `FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION=true`,
`FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM=false`, `FORGEJO_OAUTH2_ACCOUNT_LINKING=login`,
and the `FORGEJO_OIDC_*` tenant/group gates are required by the validator.
Do not set registration email confirmation to true while mail is disabled.

The staging compose file enables the mounted Eliza theme through
`FORGEJO_THEMES` and `FORGEJO_DEFAULT_THEME`; the app.ini template contains the
same defaults for file-based deployments.

Validate the private env before rendering or starting Compose:

```bash
deployment/hetzner-staging/scripts/validate-env.sh
```

On the target host, run the read-only host preflight before first deploy:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
deployment/hetzner-staging/scripts/host-preflight.sh
```

To validate the runner registration path too:

```bash
VALIDATE_RUNNER=true VALIDATE_RUNNER_REGISTRATION=true \
deployment/hetzner-staging/scripts/validate-env.sh
```

The validator reports variable names only and does not print secret values.

## Reverse Proxy Notes

Use `reverse-proxy/Caddyfile.example` as the host-level TLS starting point. It
serves Forgejo at `/` and Merge Steward at `/steward/`, stripping the
`/steward` prefix before proxying to `127.0.0.1:8080`.

Use this public steward base URL for Eliza Cloud clients and deployment checks:

```bash
MERGE_STEWARD_URL=https://git.staging.example.invalid/steward
npm run doctor --prefix services/merge-steward -- "$MERGE_STEWARD_URL"
```

nginx placeholder:

```nginx
server {
	listen 443 ssl http2;
	server_name git.staging.example.invalid;

	location / {
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto https;
		proxy_set_header X-Forwarded-Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_pass http://127.0.0.1:3000;
	}

	location = /steward {
		return 308 /steward/;
	}

	location /steward/ {
		rewrite ^/steward/?(.*)$ /$1 break;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto https;
		proxy_set_header X-Forwarded-Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_pass http://127.0.0.1:8080;
	}
}
```

Use a real private staging hostname only on the host or secret-managed deployment layer, not in this repository.

## SSO Setup

Forgejo should not allow public registration in staging. Use Eliza Cloud / Steward as the OIDC provider and add the provider after Forgejo has a locked app.ini and a recovery admin account.

The auth source command and claim mapping are documented in `../../docs/eliza-cloud-sso-plan.md`. The callback URL registered with Eliza Cloud should be:

```text
${FORGEJO_ROOT_URL}user/oauth2/${FORGEJO_OIDC_AUTH_NAME}/callback
```

After Forgejo is running, verify the identity bootstrap state:

```bash
APPLY_BOOTSTRAP=false deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh
```

The script is read-only by default. It also checks OIDC auth source config drift
against Forgejo's `login_source` row in Postgres: provider, client ID,
discovery URL, scopes, local 2FA policy, and tenant/group claim gates must match
the private Eliza Cloud env. It writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json`, which is
required by production SSO evidence as `sso.bootstrapEvidence`. To create the
local recovery admin and add the Eliza Cloud OIDC auth source when they are
missing, run it explicitly:

```bash
APPLY_BOOTSTRAP=true deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh
```

If the first boot must create SSO before the steward bot token exists, use:

```bash
CHECK_STEWARD_TOKEN=false APPLY_BOOTSTRAP=true \
deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh
```

Then create the steward token, add it to the private `.env`, and rerun the
script without overrides so the token owner is verified.

It never prints the recovery admin password, OIDC client secret, or steward
token. Existing auth sources are not rewritten automatically; if drift is
reported, update the source deliberately, then rerun the verifier. Store secret
values only in the host secret store and private `.env`.

For production cutover evidence, generate the non-secret SSO block after the
bootstrap verifier, human/agent/service identity smoke tests,
issuer-restriction review, and recovery-admin check pass:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
SSO_SMOKE_OUTPUT=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs

ENV_FILE=deployment/hetzner-staging/.env \
SSO_EVIDENCE_SMOKE_JSON=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON=$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json \
deployment/hetzner-staging/scripts/sso-evidence.mjs
```

The smoke helper writes private structured JSON with `ssoSmoke.issuerUrl`,
`checkedAt`, `oidcLoginSucceeded`, `humanIdentitySmokePassed`,
`agentIdentitySmokePassed`, `serviceIdentitySmokePassed`,
`publicRegistrationLocked`, `nonIssuerRejected`, and
`recoveryAdminLoginSucceeded` after all required `SSO_SMOKE_*` checks are true.
Production gate validation records the smoke JSON source path and SHA-256 digest
in `sso.smokeEvidence`, and records the read-only identity bootstrap receipt in
`sso.bootstrapEvidence`, so keep both artifacts available until the release gate
passes. If the smoke result is not available as JSON, set `SSO_EVIDENCE_SMOKE_TESTED`,
`SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER`, and
`SSO_EVIDENCE_RECOVERY_ADMIN_VERIFIED` only after those checks pass; production
cutover still requires structured smoke artifact provenance.

## Merge Steward

The steward service is behind the `steward` compose profile. Keep it disabled
until there is:

- a signed service image
- a dedicated steward database or schema
- a narrow Forgejo bot token
- a signed Forgejo webhook secret
- either a private static API token or validated Eliza Cloud OIDC JWTs
- a policy for protected branches and required checks
- a configured event gate allowlist for repositories that can mutate queue state

The steward should call Forgejo over `FORGEJO_BASE_URL`, receive signed
webhooks, and write queue state to Postgres. Use
`MERGE_STEWARD_DEPLOYMENT_MODE=production` for a real externally reachable
service; that mode fails startup until Postgres, control API auth, webhook
replay protection, webhook secret, and event gating are configured. It must not
run untrusted PR code on the Forgejo host.

The `steward` profile runs `merge-steward-migrate` before starting the HTTP
service. The HTTP service then exposes `/ready`, and the compose healthcheck
uses that endpoint so the reverse proxy or operator can see whether runtime
preflight, queue-store access, and worker-lease access are healthy.
`GET /metrics` is available for a private Prometheus-compatible scraper when
`MERGE_STEWARD_METRICS_ENABLED=true`; keep
`MERGE_STEWARD_METRICS_AUTH_REQUIRED=true` outside local-only demos.

The merge worker can run inside the steward process by setting
`MERGE_STEWARD_WORKER_ENABLED=true` and
`MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true`. Keep it disabled until live
integration, required checks, bot permissions, and runner isolation are tested.
Worker-enabled steward replicas coordinate through the durable worker lease in
Postgres, so only the current lease holder can auto-claim merge work. The
worker also recovers stale active queue items older than
`MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS` before claiming the next PR or train.

Before generating merge queue rollout evidence or enabling live worker
execution, run the safe rollout drill:

```bash
MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT=$ELIZA_ARTIFACT_ROOT/merge-queue-rollout-drill.json \
deployment/hetzner-staging/scripts/merge-queue-rollout-drill.sh
```

The drill verifies `/ready`, the deployment doctor, a synthetic non-mutating
integration plan, and the safety gates that keep manual execution and
`run-once` blocked without explicit confirmation. It does not push branches,
merge PRs, or claim queue work. Pass the generated JSON file to
`scripts/merge-queue-rollout-evidence.mjs` as
`MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON` before marking dry-run evidence true.
For staged live rollout, also pass `MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON`
with the artifact generated by `scripts/merge-queue-live-drill-evidence.mjs`.
That helper runs one confirmed live `run-once`, verifies the worker lease,
captures integration action checkpoints, and requires rollback, human approval,
and staged stack dependency order sign-off plus release-readiness proof before
writing the private JSON file.

## Actions Runner

Use the staging runner overlay only after Forgejo is healthy and registration
scope is chosen. This runner pool uses Docker-in-Docker instead of the host
Docker socket and intentionally avoids `:host` runner labels.

Register:

```bash
cp deployment/hetzner-staging/runner/config.example.yml deployment/hetzner-staging/runner/data/config.yml
FORGEJO_RUNNER_REGISTRATION_TOKEN=... \
deployment/hetzner-staging/scripts/register-actions-runner.sh
```

Start:

```bash
docker compose \
  --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  -f deployment/hetzner-staging/compose.actions-runner.yml \
  --profile steward \
  --profile actions-runner \
  up -d actions-dind actions-runner
```

Verify:

```bash
deployment/hetzner-staging/scripts/check-actions-runner.sh
```

Keep capacity at `1` until `scripts/runner-smoke-evidence.mjs` verifies a
trusted smoke workflow pass and runner egress, secret exposure, and
required-check policy are reviewed.

## Backup and Restore Drill

Create a staging backup from the deployment host after `.env` is filled and the
Compose services are running:

```bash
deployment/hetzner-staging/scripts/backup.sh
```

The backup bundle includes:

- a logical Postgres cluster dump from the `postgres` service
- Forgejo data and config archives from the running Forgejo container
- the Eliza custom layer and templates from this repository
- the staging compose file and `.env.example`
- a key-only environment manifest, never secret values
- checksums and a manifest for restore validation

Verify the bundle before any restore drill:

```bash
deployment/hetzner-staging/scripts/restore-check.sh deployment/hetzner-staging/backups/<backup-name>
```

Create the age identity on a separate recovery system. Keep the identity off
the application host; copy only its public recipient file to the host:

```bash
umask 077
age-keygen -o /secure/eliza-hub-backup-identity.txt
age-keygen -y /secure/eliza-hub-backup-identity.txt > age-recipients.txt
```

Configure an rclone remote in the private file named by `RCLONE_CONFIG`, then
set `BACKUP_OFFSITE_REMOTE` and `BACKUP_AGE_RECIPIENTS_FILE` in the deployment
`.env`. The destination should be a dedicated, access-restricted bucket or
prefix. Before the first production upload, add and review an R2 bucket lock
for the backup prefix so the service rejects deletion and overwrite during the
retention window. For example, after choosing the real retention policy:

```bash
npx --yes wrangler@latest r2 bucket lock add eliza-hub-backups \
  --name staging-backups-90-days --prefix staging/ --retention-days 90
npx --yes wrangler@latest r2 bucket lock list eliza-hub-backups
```

Review the safe backup plan, then create, verify, encrypt, and upload one
backup:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
deployment/hetzner-staging/scripts/run-scheduled-backup.sh

ENV_FILE=deployment/hetzner-staging/.env \
deployment/hetzner-staging/scripts/run-scheduled-backup.sh --apply
```

The apply result identifies the local upload receipt and immutable remote
receipt, and prints the upload receipt SHA-256. Transfer that digest to the
recovery operator separately from the bucket credentials. On the separate
recovery system, download and decrypt that remote backup into disk-backed
temporary storage and retain the resulting receipt:

```bash
ALLOW_ENV_ONLY=true \
BACKUP_OFFSITE_ALLOWED_REMOTE=r2:eliza-hub-backups/staging \
BACKUP_AGE_IDENTITY_FILE=/secure/eliza-hub-backup-identity.txt \
BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT=$ELIZA_ARTIFACT_ROOT/offsite-restore-receipt.json \
deployment/hetzner-staging/scripts/restore-offsite-check.sh \
  --receipt-remote r2:eliza-hub-backups/staging/<backup-name>/receipt.json \
  --expected-receipt-sha256 <upload-receipt-sha256> \
  --apply
```

Install the reviewed timer examples after the repository is available at
`/srv/eliza-hub/current` and the private env is stored at
`/srv/eliza-hub/shared/eliza-hub.env`:

```bash
sudo install -m 0644 deployment/hetzner-staging/systemd/eliza-hub-backup.service.example \
  /etc/systemd/system/eliza-hub-backup.service
sudo install -m 0644 deployment/hetzner-staging/systemd/eliza-hub-backup.timer.example \
  /etc/systemd/system/eliza-hub-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now eliza-hub-backup.timer
systemctl list-timers eliza-hub-backup.timer
```

Generate the non-secret production evidence block only after both receipts
exist and the timer is enabled:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
BACKUP_EVIDENCE_SCHEDULED=true \
deployment/hetzner-staging/scripts/backup-evidence.mjs \
  --backup-dir /srv/eliza-hub/shared/backups/<backup-name> \
  --offsite-upload-receipt /srv/eliza-hub/shared/backups/receipts/<backup-name>/upload-receipt.json \
  --offsite-restore-receipt $ELIZA_ARTIFACT_ROOT/offsite-restore-receipt.json
```

The helper derives off-host, encryption, backup time, and restore status from
the receipt contents. It verifies source bundle hashes, remote paths,
ciphertext identity, receipt linkage, and chronology; operator booleans cannot
substitute for those artifacts.

The restore checker is intentionally non-destructive. For a database drill that
does not touch the live Compose stack, restore the dump into a disposable
loopback-only Postgres container and run steward migrations:

```bash
RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true \
deployment/hetzner-staging/scripts/restore-drill.sh deployment/hetzner-staging/backups/<backup-name>
```

After `merge-steward-migrate` and the disposable restore drill pass, generate
the non-secret database evidence block from captured logs:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
deployment/hetzner-staging/scripts/database-evidence.mjs \
  --migration-output $ELIZA_ARTIFACT_ROOT/merge-steward-migrate.log \
  --restore-drill-output $ELIZA_ARTIFACT_ROOT/restore-drill.log
```

Run full live restore drills only onto an empty staging host with fresh secrets
from the host secret store, then start Forgejo, run the steward migrations, and
finish with:

```bash
npm run doctor --prefix services/merge-steward -- <steward-url>
```

The doctor verifies health, readiness, discovery, OpenAPI, runtime preflight,
strict work-reservation, strict Work-item, branch-namespace, verified run-receipt, and
stack-dependency posture for live integration, metrics, workflow, project
board, merge queue, search, release readiness, repository protection, agent insights,
agent capacity, agent performance, agent routing, agent bootstrap, agent
cockpit, agent action plan, queue simulation, submission/preflight/reservation
gates, CI failure analysis, PR brief, review assignment, patch conflict
prediction, and agent inbox API responses. Set
`MERGE_STEWARD_SMOKE_REPO` and `MERGE_STEWARD_SMOKE_AGENT` if the target smoke
repo or agent id differs from the defaults.

## Observability

Use `observability/prometheus.yml` and
`observability/merge-steward-alerts.yml` as the private staging Prometheus
starting point. The scrape config expects a bearer token file at
`/etc/prometheus/secrets/merge-steward-token`; do not commit that file.

The alert rules cover steward reachability, readiness, partial metric scrape
failures, production persistence, worker/live-integration mismatches, strict
work-reservation and Work-item posture, worker lease ownership, expired agent claims, queue
backlog, and failed runs/attempts.
See `observability/README.md` for validation commands and response notes.

## Post-Deploy Verification

After the compose stack is up on the staging host, run:

```bash
deployment/hetzner-staging/scripts/post-deploy-check.sh
```

The verifier is read-only. It checks compose rendering, container running and
health status, Forgejo HTTP reachability, Forgejo recovery admin and Eliza
Cloud SSO bootstrap state, Merge Steward `/health`, `/ready`, `/metrics`, the
workflow, project board, merge queue, search, release readiness, repository protection,
agent insights, agent capacity, agent performance, agent routing, agent
bootstrap, agent cockpit, agent action plan, submission gate, CI failure analysis, PR brief,
review assignment, patch conflict prediction, agent inbox APIs, discovery, OpenAPI, the deployment doctor, the
safe merge queue rollout drill, and Prometheus config syntax when `promtool` is
installed. It exits nonzero if a release-blocking check fails and writes a
private JSON receipt to
`$ELIZA_ARTIFACT_ROOT/eliza-hub-post-deploy-evidence.json` by default. The
receipt records target URLs, timestamps, every check name, pass/fail status,
and warning counts.

Useful overrides:

```bash
ENV_FILE=/private/eliza-hub.env \
FORGEJO_LOCAL_URL=http://127.0.0.1:3000 \
STEWARD_LOCAL_URL=http://127.0.0.1:8080 \
MERGE_STEWARD_DOCTOR_TOKEN=... \
MERGE_STEWARD_SMOKE_REPO=elizaos/eliza \
MERGE_STEWARD_SMOKE_AGENT=eliza-smoke-agent \
deployment/hetzner-staging/scripts/post-deploy-check.sh
```

## Release and Rollback

Before changing a running staging host, run:

```bash
deployment/hetzner-staging/scripts/release-gate.sh
```

Then follow `release/README.md` and fill `release/CHECKLIST.md` for the staged
release. For production or cutover checks, run the gate with
`RELEASE_GATE_MODE=production` and `PRODUCTION_EVIDENCE_FILE` set to the private
assembled evidence file. Keep previous image tags and a verified backup bundle
before pulling new images or applying migrations.

For production cutover, fill a private copy of
`release/production-evidence.example.json` and require
`node services/merge-steward/src/cli.js production-gate` to pass before
routing real users or enabling live merge execution.
Use `node services/merge-steward/src/cli.js domain-evidence <root-url>` to
generate the private `domain` evidence block from the live HTTPS Forgejo root
after TLS is configured.
Use `scripts/secret-management-evidence.mjs` to generate the private `secrets`
evidence block after the host secret store and rotation policy are in place.
Use `scripts/mail-evidence.mjs` to generate the private `mail` evidence block
after SMTP and mail smoke tests pass.
Use `scripts/storage-evidence.mjs` to generate the private `storage` evidence
block after sizing and retention reviews pass.
Use `scripts/observability-evidence.mjs` to generate the private
`observability` evidence block after scrape, alert, log, and retention checks
pass, with retained local audit artifact SHA-256 provenance.
Use `scripts/backup-evidence.mjs` to generate the private `backups` evidence
block after backup verification, encrypted off-host sync, and schedule review
pass.
Use `scripts/database-evidence.mjs` to generate the private `database` evidence
block after Postgres, migration, checksum drift, and empty-host restore drill
checks pass.
Use `scripts/repository-evidence.mjs --require-live` to generate the private
`repository` evidence block from the steward's live Forgejo protection audit
after Actions policy and admin-bypass reviews pass.
Use `scripts/pilot-bootstrap.mjs --apply` to generate the private
`githubMigration` evidence receipt after the GitHub pull mirror, steward
webhook, branch protection, repo policy, trusted agent identities, and pilot
surfaces are created or verified.
Use `scripts/steward-evidence.mjs` to generate the private `steward` evidence
block after production preflight, deployment doctor, label mirroring, and
bot-token permission reviews pass. Production release-gate mode re-reads and
hash-checks the referenced preflight and doctor JSON files, so keep those
artifacts available until the gate has passed.
Use `scripts/merge-queue-rollout-evidence.mjs` to generate the private
`mergeQueueRollout` evidence block from the safe drill JSON and staged live
drill JSON after worker lease, stack-order, rollback drill, and human approval
checks pass.
Production release-gate mode re-reads those rollout source artifacts, so keep
the referenced dry-run and staged live JSON files available until the gate has
passed. The artifact digests are included in the generated evidence and checked
again by the production gate.
Use `scripts/security-review-evidence.mjs` to generate the private
`securityReview` evidence block after auth, token, runner execution, and repo
permission reviews are approved.
After an applied deploy, keep `$ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json`
and `$ELIZA_ARTIFACT_ROOT/eliza-hub-post-deploy-evidence.json`; the assembler
turns the deploy receipt into the production-gate `deployment` block and
production release-gate mode re-reads both receipts before cutover.
Use `scripts/production-evidence-inventory.mjs --strict` to verify the expected
private evidence fragments exist and contain the right top-level blocks, then
use `scripts/production-evidence-assemble.mjs` to merge them before running the
production gate.
Production release-gate mode also rejects stale or future-dated evidence
timestamps.

## Safety Checklist Before Deployment

- Replace every `example.invalid` value outside Git.
- Generate secrets on the staging host.
- Run `scripts/validate-env.sh` against the private `.env` and fix every error.
- Run `scripts/release-gate.sh` before changing services.
- Set `ELIZA_ARTIFACT_ROOT` and `ELIZA_TMP_ROOT` to disk-backed private roots
  before generating release evidence.
- Confirm `ROOT_URL`, SSH domain, and reverse proxy headers.
- Enable TLS and host firewall rules.
- Schedule encrypted off-host backups for Postgres, repositories, attachments, LFS, packages, and config.
- Run `scripts/backup.sh`, verify the bundle with `scripts/restore-check.sh`,
  and complete an empty-host restore drill.
- Run `scripts/bootstrap-forgejo-identity.sh`; if it reports missing identity
  state, run it once with `APPLY_BOOTSTRAP=true` from the staging host.
- Keep runners isolated from the Forgejo web server; use
  `compose.actions-runner.yml`, not the local host runner, for staging CI.
- Confirm the `merge-steward-migrate` job exits successfully before starting
  the steward service.
- Verify OIDC login and local admin recovery before inviting users.
- Check `GET /ready` on the steward and require `runtime_preflight.ok=true`
  before routing traffic to it.
- Run `npm run doctor --prefix services/merge-steward -- <steward-url>` from a
  trusted network path and require `doctor.ok=true`, including product API
  checks.
- Wire Prometheus to `/metrics`, load the steward alert rules, and route page
  severity alerts before live merge execution.
- Run `scripts/post-deploy-check.sh` on the staging host and require every
  release-blocking check, including workflow/board/merge queue/search/work
  pages/fleet coordination/work context/release readiness/repository
  protection/insights/agents/performance/routing/bootstrap/cockpit/action
  plan/submission gate/work preflight/work reservation/CI failure analysis/PR
  brief/review assignment/patch conflict prediction/inbox API smoke, to pass.
- Register and verify the isolated Actions runner with
  `scripts/register-actions-runner.sh` and `scripts/check-actions-runner.sh`
  before enabling agent PR workflows.
- Generate private runner evidence with `scripts/runner-evidence.sh` after
  `scripts/runner-smoke-evidence.mjs` verifies the trusted runner smoke
  workflow and operator reviews pass, then copy its generated `runner`
  production fragment into the private evidence file.
- Keep `MERGE_STEWARD_WORKER_ENABLED=false` until the first live merge-queue
  drill is approved.
- Keep `FORGEJO_ENRICHMENT_ENABLED=true` for live integration so the steward
  refreshes review, approval, head SHA, changed-file, and check facts before
  merging.
