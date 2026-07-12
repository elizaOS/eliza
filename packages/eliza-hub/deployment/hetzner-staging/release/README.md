# Release and Rollback

This runbook is for private staging releases. It assumes Docker Compose on the
host, secrets in the private `.env`, and a reverse proxy terminating TLS.

## Release Gates

On a fresh local checkout, create the gitignored private env before running the
gate:

```bash
deployment/hetzner-staging/scripts/generate-private-env.sh
```

Before changing a running host:

```bash
deployment/hetzner-staging/scripts/host-preflight.sh
deployment/hetzner-staging/scripts/release-gate.sh
```

The gate is read-only. It verifies:

- required deployment files exist
- the Git worktree is clean
- staging shell scripts parse
- staging and local helper shell scripts pass ShellCheck
- deployment Node helpers parse
- pinned Hetzner and Cloudflare Terraform providers initialize with the remote
  backend disabled, and the infrastructure configuration formats and validates
- private/reference text scan passes
- private `.env` values are not placeholders and pass safety checks
- base and runner compose files render
- runner isolation still avoids host Docker socket, DIND port publishing, and
  `:host` labels
- Merge Steward syntax, unit tests, and production dependency audit pass

Set `RUN_TESTS=false` only when the same commit already has a green CI run.
Set `VALIDATE_RUNNER=false` only for a release that intentionally leaves the
Actions runner disabled.

For production cutover, collect private launch evidence and run the Merge
Steward production gate. The checked-in
`production-evidence.example.json` is a failing template, not proof. It points
editors at `services/merge-steward/production-evidence.schema.json` so shape
errors are caught early. The gate below also reports `evidenceShape` errors and
then enforces the real pass/fail semantics:

```bash
export ELIZA_ARTIFACT_ROOT="${ELIZA_ARTIFACT_ROOT:-$HOME/.local/state/eliza-hub/artifacts}"
export ELIZA_TMP_ROOT="${ELIZA_TMP_ROOT:-$HOME/.cache/eliza-hub/tmp}"
mkdir -p "$ELIZA_ARTIFACT_ROOT" "$ELIZA_TMP_ROOT"

cp deployment/hetzner-staging/release/production-evidence.example.json \
  "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
# Fill $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json from the real private deploy.
node services/merge-steward/src/cli.js production-gate --strict \
  < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
```

The deployment scripts use the same roots by default. Keep production evidence
under a private, disk-backed state directory; avoid `/tmp` on workstations where
it is mounted as tmpfs.

For the domain section, generate the HTTPS and canonical `ROOT_URL` evidence
from the live Forgejo endpoint. Leave `reverseProxyReviewed` false until the
host routing, `X-Forwarded-*` headers, and TLS termination config have been
reviewed. Start from `../reverse-proxy/Caddyfile.example` when using Caddy:

```bash
FORGEJO_REVERSE_PROXY_REVIEWED=true \
node services/merge-steward/src/cli.js domain-evidence https://git.example.invalid/ \
  > "$ELIZA_ARTIFACT_ROOT/domain-evidence.json"
```

Keep the generated `domain-evidence.json` artifact until production gate has
passed. The assembler converts it into the `domain` block and records
`domain.probeEvidence.source`, SHA-256 digest, timestamp, status, and check
count. Set `FORGEJO_REVERSE_PROXY_REVIEWED=true` only after the host routing,
`X-Forwarded-*` headers, and TLS termination config have been reviewed.
Production `--strict` validation re-reads that retained probe artifact, so
hand-edited `tlsVerified`, `rootUrlCanonical`, or `reverseProxyReviewed`
booleans are not sufficient for cutover.

For the SSO section, keep public Forgejo registration locked and use the Eliza
Cloud OIDC source described in `../../docs/eliza-cloud-sso-plan.md`. Run the
identity bootstrap verifier, complete real human, agent, and service identity
smoke tests, verify automatic account creation is limited to the Eliza Cloud
issuer, and verify the local recovery admin. Prefer feeding the smoke result
into the evidence helper:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
APPLY_BOOTSTRAP=false \
deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh

ENV_FILE=deployment/hetzner-staging/.env \
SSO_SMOKE_OUTPUT=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs

ENV_FILE=deployment/hetzner-staging/.env \
SSO_EVIDENCE_SMOKE_JSON=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON=$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json \
deployment/hetzner-staging/scripts/sso-evidence.mjs \
  > $ELIZA_ARTIFACT_ROOT/sso-evidence.json
```

The helper infers `oidcProviderStaged` and `forgejoOidcSourceConfigured` from
the private Eliza Cloud issuer, discovery URL, Forgejo OIDC auth source, scopes,
client id, and issued client secret. It infers `publicRegistrationLocked` from
the Compose settings that disable public registration, allow only external
registration, and require sign-in view. If those controls are enforced outside
the checked Compose file, attest them explicitly with
`SSO_EVIDENCE_OIDC_PROVIDER_STAGED`,
`SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED`, or
`SSO_EVIDENCE_PUBLIC_REGISTRATION_LOCKED`. The smoke JSON must include a valid
`checkedAt` timestamp; production gate validation records its local source path
and SHA-256 digest in `sso.smokeEvidence`. The read-only identity bootstrap
verifier writes `$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json`
and production gate validation records that receipt in `sso.bootstrapEvidence`.
If the smoke result is not available
as JSON, the live checks can still be attested explicitly for non-production
evidence with
`SSO_EVIDENCE_SMOKE_TESTED`, `SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED`,
`SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER`, and
`SSO_EVIDENCE_RECOVERY_ADMIN_VERIFIED`, but production cutover still requires
the timestamped smoke artifact and read-only identity bootstrap receipt. Copy
the generated `sso` object into the private production evidence file and keep
`$ELIZA_ARTIFACT_ROOT/sso-smoke.json` and
`$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json` available
until the gate has passed.

For the backups section, use `run-scheduled-backup.sh --apply` to create,
structurally verify, age-encrypt, upload, and download-verify a backup through
`backup.sh`, `restore-check.sh`, and `backup-offsite.sh`. Run
`restore-offsite-check.sh --apply` from a separate recovery environment that
holds the age identity, supplying the upload receipt SHA-256 through a channel
separate from the bucket. Generate the evidence block from the bundle and both
cryptographically linked receipts:

The production bucket must also have a reviewed server-side lock for the
backup prefix and retention window. `rclone --immutable` protects normal
uploads from accidental overwrite; the bucket lock protects objects after the
client finishes.

```bash
ENV_FILE=deployment/hetzner-staging/.env \
BACKUP_EVIDENCE_SCHEDULED=true \
deployment/hetzner-staging/scripts/backup-evidence.mjs \
  --backup-dir /srv/eliza-hub/shared/backups/<backup-name> \
  --offsite-upload-receipt /srv/eliza-hub/shared/backups/receipts/<backup-name>/upload-receipt.json \
  --offsite-restore-receipt $ELIZA_ARTIFACT_ROOT/offsite-restore-receipt.json \
  --audit-output $ELIZA_ARTIFACT_ROOT/backup-audit.json \
  > $ELIZA_ARTIFACT_ROOT/backup-evidence.json
```

The helper verifies `SHA256SUMS`, checks the pg_dumpall marker, reads
`MANIFEST.txt` for the backup timestamp, and infers repositories, database,
attachments, packages, LFS, and configuration coverage. It independently
re-hashes the upload and recovery receipts, verifies their bundle and
ciphertext linkage, and derives off-host, encryption, backup time, and restore
status from them. Bare operator booleans are not accepted as production proof.
The helper writes a retained local backup audit artifact to `--audit-output`,
`BACKUP_EVIDENCE_AUDIT_OUTPUT`, or `$ELIZA_ARTIFACT_ROOT/backup-audit.json`,
then records every source and SHA-256 under `backups.backupEvidence`. Keep the
bundle, both receipts, and audit artifact available until the gate has passed.

For the database section, keep Forgejo and Merge Steward on Postgres, run the
`merge-steward-migrate` job, and complete the disposable empty-host restore
drill. Capture the migration and restore-drill output, then generate evidence:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
deployment/hetzner-staging/scripts/database-evidence.mjs \
  --migration-output $ELIZA_ARTIFACT_ROOT/merge-steward-migrate.log \
  --restore-drill-output $ELIZA_ARTIFACT_ROOT/restore-drill.log \
  --audit-output $ELIZA_ARTIFACT_ROOT/database-audit.json \
  > $ELIZA_ARTIFACT_ROOT/database-evidence.json
```

The helper infers Forgejo Postgres from Compose, steward Postgres from
`MERGE_STEWARD_DATABASE_URL`, migration success plus checksum-drift safety from
`[MergeStewardMigrate] complete`, and restore-drill success from
`restore-drill.sh` output that includes the expected steward tables. If those
checks were captured elsewhere, attest them explicitly with
`DATABASE_EVIDENCE_MIGRATIONS_APPLIED`,
`DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED`, and
`DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN`. Production-ready evidence still
requires retained migration and restore-drill log artifacts. The helper writes
a retained local audit artifact to `--audit-output`,
`DATABASE_EVIDENCE_AUDIT_OUTPUT`, or
`$ELIZA_ARTIFACT_ROOT/database-audit.json`, then records its source and SHA-256
plus the migration and restore-drill log digests under
`database.databaseEvidence`. Copy the generated `database` object into the
private production evidence file and keep all three source artifacts available
until the gate has passed.

For the image provenance section, use immutable `@sha256:` references for
Forgejo, Merge Steward, Forgejo Runner, and DIND images. Record the CI build
run, signature verification, SBOM generation, and vulnerability scan result for
the Merge Steward image before marking those booleans true.

Generate the non-secret image block from the configured image values and
digests without sourcing the private env file. The helper writes a separate
retained audit artifact and records its SHA-256 under
`imageProvenance.provenanceEvidence`:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
IMAGE_PROVENANCE_STEWARD_IMAGE_BUILT_BY_CI=true \
IMAGE_PROVENANCE_STEWARD_IMAGE_SIGNATURE_VERIFIED=true \
IMAGE_PROVENANCE_SBOM_GENERATED=true \
IMAGE_PROVENANCE_VULNERABILITY_SCAN_CLEAN=true \
deployment/hetzner-staging/scripts/image-provenance-evidence.mjs \
  --provenance-output $ELIZA_ARTIFACT_ROOT/image-provenance-audit.json \
  > $ELIZA_ARTIFACT_ROOT/image-provenance.json
```

The four image variables may already contain `@sha256:` references. If they
still contain approved tags, set matching digest variables beside them:
`FORGEJO_IMAGE_DIGEST`, `MERGE_STEWARD_IMAGE_DIGEST`,
`FORGEJO_RUNNER_IMAGE_DIGEST`, and `FORGEJO_RUNNER_DIND_IMAGE_DIGEST`.
Copy the generated `imageProvenance` object into the private production
evidence file, then run the production gate. Production release-gate mode
re-reads `$ELIZA_ARTIFACT_ROOT/image-provenance-audit.json`, so keep that source
artifact available until the gate has passed.

For the runner section of that evidence, generate private runner evidence after
registration, live trusted smoke workflow verification, and operator reviews
pass:

```bash
RUNNER_SMOKE_DISPATCH=true \
RUNNER_EGRESS_REVIEWED=true \
RUNNER_SECRET_EXPOSURE_REVIEWED=true \
deployment/hetzner-staging/scripts/runner-evidence.sh
```

The helper calls `scripts/runner-smoke-evidence.mjs` to dispatch
`.forgejo/workflows/runner-smoke.yml`, polls Forgejo Actions for a passing run,
writes `$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-smoke-evidence.json`, then writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-evidence.json`, immediately runs
`node services/merge-steward/src/cli.js runner-isolation`, and writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-isolation-audit.json`. It then writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-runner-production-evidence.json`, a direct
`runner` fragment with `smokeEvidence` and `auditEvidence` source, SHA-256, and
timestamp summaries. Leave `RUNNER_SMOKE_DISPATCH` unset to verify the latest
passing trusted smoke run without triggering a new workflow.

The lower-level CLI remains available when you already have a private runner
evidence JSON:

```bash
node services/merge-steward/src/cli.js runner-isolation < $ELIZA_ARTIFACT_ROOT/eliza-hub-runner-evidence.json
```

For the secrets section, generate a non-secret block from the private env file
plus operator attestations. The helper parses `.env` as data, never sources it,
and runs the repository private-reference scan before setting
`noPlaintextSecretsCommitted=true`.

```bash
ENV_FILE=deployment/hetzner-staging/.env \
SECRET_EVIDENCE_EXTERNAL_SECRET_STORE=true \
SECRET_EVIDENCE_ROTATION_POLICY_DOCUMENTED=true \
deployment/hetzner-staging/scripts/secret-management-evidence.mjs \
  --audit-output $ELIZA_ARTIFACT_ROOT/secret-management-audit.json \
  > $ELIZA_ARTIFACT_ROOT/secret-management.json
```

Secret issuance is inferred from non-placeholder private values when possible.
If a credential was issued through the host secret store and is not retained in
`.env`, attest it explicitly with `SECRET_EVIDENCE_APP_INI_SECRETS_ISSUED`,
`SECRET_EVIDENCE_RUNNER_TOKEN_ISSUED`,
`SECRET_EVIDENCE_OAUTH_SECRETS_ISSUED`, or
`SECRET_EVIDENCE_WEBHOOK_SECRETS_ISSUED`. Copy the generated `secrets` object
into the private production evidence file and keep the retained
`secret-management-audit.json` artifact available for production gate
validation. The helper records only non-secret booleans, check names, counts,
timestamps, and the audit artifact digest under `secrets.secretEvidence`.

For the mail section, enable Forgejo SMTP in the private env, then run invite,
password-reset, and notification smoke tests against the staging host. Generate
the production evidence block after those tests pass:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
MAIL_EVIDENCE_INVITE_SMOKE_PASSED=true \
MAIL_EVIDENCE_PASSWORD_RESET_SMOKE_PASSED=true \
MAIL_EVIDENCE_NOTIFICATION_SMOKE_PASSED=true \
deployment/hetzner-staging/scripts/mail-evidence.mjs \
  --audit-output $ELIZA_ARTIFACT_ROOT/mail-smoke-audit.json \
  > $ELIZA_ARTIFACT_ROOT/mail-evidence.json
```

`smtpConfigured` is inferred from `FORGEJO_MAIL_ENABLED=true` plus complete
SMTP host, port, sender, user, and password settings. If SMTP is configured
outside `.env`, set `MAIL_EVIDENCE_SMTP_CONFIGURED=true`. Copy the generated
`mail` object into the private production evidence file and keep the retained
`mail-smoke-audit.json` artifact available for production gate validation. The
helper records only non-secret smoke booleans, check names, counts,
timestamps, and the audit artifact digest under `mail.mailEvidence`.

For the storage section, record the reviewed repository, attachment, package,
LFS, artifact, and log retention plan. Action artifact/log retention is
inferred from the private env; capacity and non-action retention reviews are
explicit attestations:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
STORAGE_EVIDENCE_SIZING_REVIEWED=true \
STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED=true \
STORAGE_EVIDENCE_LFS_CAPACITY_REVIEWED=true \
deployment/hetzner-staging/scripts/storage-evidence.mjs \
  --audit-output $ELIZA_ARTIFACT_ROOT/storage-retention-audit.json \
  > $ELIZA_ARTIFACT_ROOT/storage-evidence.json
```

If retention is enforced outside the Forgejo env, override
`STORAGE_EVIDENCE_ARTIFACT_RETENTION_CONFIGURED=true` or
`STORAGE_EVIDENCE_LOG_RETENTION_CONFIGURED=true`. Copy the generated `storage`
object into the private production evidence file and keep the retained
`storage-retention-audit.json` artifact available for production gate
validation. The helper records only non-secret retention values, review
booleans, check names, counts, timestamps, and the audit artifact digest under
`storage.storageEvidence`.

For the observability section, first run `promtool`, the deployment doctor,
the Prometheus scrape check, log-retention review, and page-alert review from
the private staging host. Generate the evidence block only after those checks
are true:

```bash
OBSERVABILITY_EVIDENCE_PROMETHEUS_SCRAPE_OK=true \
OBSERVABILITY_EVIDENCE_ALERT_RULES_LOADED=true \
OBSERVABILITY_EVIDENCE_ALERT_ROUTING_CONFIGURED=true \
OBSERVABILITY_EVIDENCE_LOGS_COLLECTED=true \
OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS=30 \
OBSERVABILITY_EVIDENCE_NO_PAGE_ALERTS_FIRING=true \
deployment/hetzner-staging/scripts/observability-evidence.mjs \
  --audit-output $ELIZA_ARTIFACT_ROOT/observability-audit.json \
  > $ELIZA_ARTIFACT_ROOT/observability-evidence.json
```

Copy the generated `observability` object into the private production evidence
file and keep the retained `observability-audit.json` artifact available for
production gate validation. The helper records only non-secret observability
booleans, log-retention days, check names, counts, timestamps, and the audit
artifact digest under `observability.observabilityEvidence`.

For the steward section, capture production runtime preflight and deployment
doctor output from the private staging host, then record label-mirroring and
bot-token permission reviews:

```bash
node services/merge-steward/src/cli.js preflight > $ELIZA_ARTIFACT_ROOT/steward-preflight.json
npm run doctor --prefix services/merge-steward -- <steward-url> \
  > $ELIZA_ARTIFACT_ROOT/steward-doctor.json
ENV_FILE=deployment/hetzner-staging/.env \
MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true \
MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true \
MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true \
MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true \
MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true \
STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED=true \
STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED=true \
deployment/hetzner-staging/scripts/steward-evidence.mjs \
  --preflight-json $ELIZA_ARTIFACT_ROOT/steward-preflight.json \
  --doctor-json $ELIZA_ARTIFACT_ROOT/steward-doctor.json \
  > $ELIZA_ARTIFACT_ROOT/steward-evidence.json
```

`readyProductionMode` is inferred when preflight is green in production mode
with no errors and the deployment doctor reports `ok=true`. If the evidence was
captured by another deployment job, attest it explicitly with
`STEWARD_EVIDENCE_READY_PRODUCTION_MODE`. Copy the generated `steward` object
into the private production evidence file, including `preflightEvidence` and
`doctorEvidence` with their SHA-256 digests. The helper derives
`strictWorkReservationsEnforced` from
`MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS`, derives
`strictWorkItemsEnforced` from
`MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS`, derives
`strictAgentBranchNamespacesEnforced` from
`MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE`, derives
`verifiedAgentRunReceiptsEnforced` from
`MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT`, derives
`agentIdentityRegistryEnforced` from
`MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY`, and the production gate
requires all four before live merge execution is accepted. Production release-gate mode re-reads the referenced
preflight and doctor JSON artifacts, so keep `$ELIZA_ARTIFACT_ROOT/steward-preflight.json` and
`$ELIZA_ARTIFACT_ROOT/steward-doctor.json` available until the gate has passed.

For the repository section, verify branch protection and required checks through
the deployed steward's live Forgejo audit, then record Actions policy and
admin-bypass reviews. The helper refuses live evidence unless the audit is
`productionReady` with `requireLive=true`:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED=true \
REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED=true \
deployment/hetzner-staging/scripts/repository-evidence.mjs \
  --steward-url "$MERGE_STEWARD_URL" \
  --repo elizaos/eliza \
  --target-branch develop \
  --require-live \
  > $ELIZA_ARTIFACT_ROOT/repository-evidence.json
```

`forkPolicyReviewed` is inferred when the live repository audit passes the fork
policy check. `protectedBranches` and `requiredChecks` are copied from the live
repository policy returned by the steward, and `liveProtectionEvidence` records
the retained local audit source, SHA-256 digest, timestamp, status, and check
count required by the production gate. When `--steward-url` is used, the helper
writes the fetched live audit to `$ELIZA_ARTIFACT_ROOT/repository-protection.json`
by default so production release-gate mode can re-read it. If the audit JSON was
captured by a deployment job, pass
`--repository-protection-json $ELIZA_ARTIFACT_ROOT/repository-protection.json`
instead of `--steward-url`.

For the GitHub migration rehearsal section, run the private pilot bootstrap
against the live Forgejo and steward after repository protection is configured.
Dry-run output is useful for review, but production cutover requires the
applied `--apply` receipt:

```bash
PILOT_BOOTSTRAP_EVIDENCE_OUT=$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json \
deployment/hetzner-staging/scripts/pilot-bootstrap.mjs

PILOT_BOOTSTRAP_EVIDENCE_OUT=$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json \
deployment/hetzner-staging/scripts/pilot-bootstrap.mjs --apply
```

The applied receipt proves the private pull mirror from GitHub, steward webhook,
default branch, branch protection, repo policy, trusted agent identities, and
pilot product surfaces were created or verified. The production evidence
assembler converts that retained receipt into the `githubMigration` block,
including source path, SHA-256 digest, timestamp, GitHub upstream host, step
count, required check count, trusted agent count, and the migration guardrail
booleans. Production release-gate mode re-reads
`$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json`; keep it local
and outside Git until the gate has passed.

For the merge queue rollout section, complete the dry run, staged live drill,
worker lease verification, strict work-reservation verification, strict
Work-item verification, branch namespace verification, stack dependency order
proof, rollback drill, and human approval record before enabling live merge
execution:

```bash
MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT=$ELIZA_ARTIFACT_ROOT/merge-queue-rollout-drill.json \
deployment/hetzner-staging/scripts/merge-queue-rollout-drill.sh

ENV_FILE=deployment/hetzner-staging/.env \
MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION=true \
MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED=true \
MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED=true \
MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED=true \
deployment/hetzner-staging/scripts/merge-queue-live-drill-evidence.mjs \
  --output $ELIZA_ARTIFACT_ROOT/merge-queue-live-drill.json

ENV_FILE=deployment/hetzner-staging/.env \
MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON=$ELIZA_ARTIFACT_ROOT/merge-queue-rollout-drill.json \
MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON=$ELIZA_ARTIFACT_ROOT/merge-queue-live-drill.json \
deployment/hetzner-staging/scripts/merge-queue-rollout-evidence.mjs \
  > $ELIZA_ARTIFACT_ROOT/merge-queue-rollout-evidence.json
```

The rollout drill is safe by default: it checks `/ready`, runs the deployment
doctor, asks the planner to build a synthetic integration plan, and verifies
that manual execution plus worker `run-once` stay blocked without confirmation.
It does not push branches, merge PRs, or claim live queue work. The evidence
helper refuses `dryRunPassed=true` unless `MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON`
points at the JSON artifact produced by that drill. The operator flag
`MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED=true` is not enough by itself. The
staged live helper runs one confirmed `run-once`, verifies the worker lease and
`MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true` plus
`MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true` plus
`MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true` from `/ready`, and the same
release requires `MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true` and
`MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true` with a non-zero effective
registered agent count from `/ready` before live merge rollout is accepted. The
effective count includes the env bootstrap list plus persisted active steward
agent identities. It also requires
`MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED=true` after a staged
stacked child has been blocked until its parent is mergeable first. The helper
embeds a release-readiness proof snapshot showing the blocked child, next
parent, and `merge_stack_parents_first` action. It reads the resulting run
events and writes
`$ELIZA_ARTIFACT_ROOT/merge-queue-live-drill.json`. The rollout evidence helper
also refuses staged live rollout evidence unless
`MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON` contains a successful live drill
with strict work-reservation, strict Work-item, branch namespace, and verified
agent run receipt posture, a registered agent identity posture, stack
dependency order proof from release readiness, a merged queue item, succeeded
run, executed integration actions, and
`IntegrationActionStarted`/`IntegrationActionFinished` run events.

Copy the generated `mergeQueueRollout` object into the private production
evidence file, including `strictWorkReservationsEnforced`,
`strictWorkItemsEnforced`, `strictAgentBranchNamespacesEnforced`,
`verifiedAgentRunReceiptsEnforced`, `agentIdentityRegistryEnforced`,
`stackDependencyOrderEnforced`, plus the `dryRunEvidence` and `liveDrillEvidence`
provenance fields and SHA-256 digests.
The production gate requires those artifact summaries in addition to the
boolean pass/fail fields. In production release-gate mode, the gate re-reads the
backup audit, database audit and database logs, image provenance, SSO smoke,
runner, repository protection, steward runtime, rollout, and security review
source artifacts. It fails if their digest, checkedAt, run id, check count, or
pass criteria do not match the copied summary, so keep those local artifacts
available until the gate has passed.

For the security review section, record the auth, token, runner execution, and
repository permission review sign-off:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
SECURITY_REVIEW_EVIDENCE_AUTH_REVIEWED=true \
SECURITY_REVIEW_EVIDENCE_TOKENS_REVIEWED=true \
SECURITY_REVIEW_EVIDENCE_RUNNER_EXECUTION_REVIEWED=true \
SECURITY_REVIEW_EVIDENCE_REPO_PERMISSIONS_REVIEWED=true \
SECURITY_REVIEW_EVIDENCE_APPROVED_BY=eliza-security \
SECURITY_REVIEW_EVIDENCE_APPROVED_AT=2026-07-06T13:00:00Z \
deployment/hetzner-staging/scripts/security-review-evidence.mjs \
  --audit-output $ELIZA_ARTIFACT_ROOT/security-review-audit.json \
  > $ELIZA_ARTIFACT_ROOT/security-review-evidence.json
```

`approvedAt` is normalized to an ISO timestamp. The helper writes a retained
local audit artifact to `--audit-output`,
`SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT`, or
`$ELIZA_ARTIFACT_ROOT/security-review-audit.json`, then records that artifact
source and SHA-256 under `securityReview.securityEvidence`. Copy the generated
`securityReview` object into the private production evidence file and keep the
audit artifact available until the gate has passed.

After generating the private evidence fragments, assemble them into a single
production evidence file outside Git. First inventory the private artifact root
so missing, malformed, or wrong-block fragments are visible before assembly:

```bash
deployment/hetzner-staging/scripts/production-evidence-inventory.mjs \
  --artifact-root "$ELIZA_ARTIFACT_ROOT"
```

Use `--strict` to fail the preflight until every expected fragment exists and
contains its expected production evidence block. The inventory output is also
the non-secret audit manifest for assembly: each present fragment includes its
size, SHA-256 digest, and filesystem modification timestamp, so operators can
prove exactly which private evidence files were checked before cutover. When
the inventory is complete, assemble the private evidence file:

```bash
deployment/hetzner-staging/scripts/production-evidence-assemble.mjs \
  --template deployment/hetzner-staging/release/production-evidence.example.json \
  --out $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json \
  $ELIZA_ARTIFACT_ROOT/domain-evidence.json \
  $ELIZA_ARTIFACT_ROOT/sso-evidence.json \
  $ELIZA_ARTIFACT_ROOT/backup-evidence.json \
  $ELIZA_ARTIFACT_ROOT/database-evidence.json \
  $ELIZA_ARTIFACT_ROOT/image-provenance.json \
  $ELIZA_ARTIFACT_ROOT/eliza-hub-runner-production-evidence.json \
  $ELIZA_ARTIFACT_ROOT/repository-evidence.json \
  $ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json \
  $ELIZA_ARTIFACT_ROOT/secret-management.json \
  $ELIZA_ARTIFACT_ROOT/mail-evidence.json \
  $ELIZA_ARTIFACT_ROOT/storage-evidence.json \
  $ELIZA_ARTIFACT_ROOT/observability-evidence.json \
  $ELIZA_ARTIFACT_ROOT/steward-evidence.json \
  $ELIZA_ARTIFACT_ROOT/merge-queue-rollout-evidence.json \
  $ELIZA_ARTIFACT_ROOT/security-review-evidence.json \
  $ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json
```

You can also require the same gate inside the read-only release gate. Use
`RELEASE_GATE_MODE=production` for cutover or hosted production checks after an
applied deploy and post-deploy verification have written their private
receipts. Production mode defaults `VALIDATE_PRODUCTION_GATE=true` and
`VALIDATE_PRODUCTION_INVENTORY=true`, and fails without
`PRODUCTION_EVIDENCE_FILE`. It first reruns
`production-evidence-inventory.mjs --strict` against the private artifact root.
It also re-reads the domain probe, re-reads the backup audit, database audit
and database logs, image provenance, SSO smoke, runner, repository protection,
secret management, mail smoke, storage retention, observability, steward
runtime, rollout, security review source artifacts referenced by the private evidence file,
plus deploy and post-deploy source artifacts, and rejects stale or future-dated
production evidence timestamps.

```bash
RELEASE_GATE_MODE=production \
PRODUCTION_EVIDENCE_FILE=$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json \
deployment/hetzner-staging/scripts/release-gate.sh
```

Do not route real users or enable live merge execution until this gate passes
with real evidence.

## Pre-Release Snapshot

Record the release input before pulling images or changing services:

```bash
git rev-parse HEAD
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward config > $ELIZA_ARTIFACT_ROOT/eliza-hub-release-compose.yml
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward images
```

Create and verify a backup:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
  deployment/hetzner-staging/scripts/run-scheduled-backup.sh --apply
ALLOW_ENV_ONLY=true \
  BACKUP_OFFSITE_ALLOWED_REMOTE=r2:eliza-hub-backups/staging \
  BACKUP_AGE_IDENTITY_FILE=/secure/eliza-hub-backup-identity.txt \
  deployment/hetzner-staging/scripts/restore-offsite-check.sh \
    --receipt-remote r2:eliza-hub-backups/staging/<backup-name>/receipt.json \
    --expected-receipt-sha256 <upload-receipt-sha256> --apply
RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true \
  deployment/hetzner-staging/scripts/restore-drill.sh /srv/eliza-hub/shared/backups/<backup-name>
```

Do not continue without a verified upload receipt, a separate recovery receipt,
a passed disposable database restore drill, and the previous image tags.

## Image Promotion

For a private pilot, make the approved `MERGE_STEWARD_IMAGE` available on the
target host before deploying. Use one of these paths.

Private registry:

```bash
docker build -t "$MERGE_STEWARD_IMAGE" services/merge-steward
docker push "$MERGE_STEWARD_IMAGE"
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward pull
```

Direct host load for a private staging box without a registry:

```bash
docker build -t "$MERGE_STEWARD_IMAGE" services/merge-steward
docker save "$MERGE_STEWARD_IMAGE" -o "$ELIZA_ARTIFACT_ROOT/merge-steward-image.tar"
scp "$ELIZA_ARTIFACT_ROOT/merge-steward-image.tar" <host>:/srv/eliza-hub/merge-steward-image.tar
ssh <host> 'docker load -i /srv/eliza-hub/merge-steward-image.tar'
```

On the target host, verify the image name resolves before running migrations or
starting services:

```bash
docker image inspect "$MERGE_STEWARD_IMAGE" >/dev/null
```

For production cutover, the image still needs retained digest, CI build,
signature, SBOM, and vulnerability-scan evidence from
`scripts/image-provenance-evidence.mjs`; a direct host load is only a private
pilot transport path.

## Deploy

Choose the first-boot path for an empty host. Use the rolling-release path only
when Postgres and Forgejo are already running and healthy.

Use the deploy orchestrator as the primary operator entrypoint. It is dry-run
by default and writes non-secret deploy evidence to
`$ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json`. The deploy evidence
records the post-deploy verification receipt path at
`files.postDeployEvidence`.

```bash
DEPLOY_MODE=first-boot deployment/hetzner-staging/scripts/deploy.sh
DEPLOY_MODE=first-boot deployment/hetzner-staging/scripts/deploy.sh --apply

DEPLOY_MODE=rolling deployment/hetzner-staging/scripts/deploy.sh
DEPLOY_MODE=rolling deployment/hetzner-staging/scripts/deploy.sh --apply --pull
```

Set `DEPLOY_RUNNER=true` or pass `--runner` only after runner registration and
runner evidence are ready. Set `DEPLOY_RUN_POST_CHECK=false` only when running
`scripts/post-deploy-check.sh` separately and preserving its private JSON
receipt.

### First Boot

Start the persistent dependencies and wait for their healthchecks:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward up -d --wait postgres forgejo

docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward ps postgres forgejo
```

Run the one-shot steward migration after Postgres is healthy:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward up merge-steward-migrate
```

Then start Merge Steward:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward up -d merge-steward
```

### Rolling Release

Pull approved images if this host uses a private registry:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward pull
```

Verify dependencies are already healthy:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward ps postgres forgejo
```

Apply database migrations without recreating dependencies:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward up --no-deps merge-steward-migrate
```

Restart the application services:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  --profile steward up -d --wait forgejo merge-steward
```

If the isolated runner is enabled:

```bash
docker compose --env-file deployment/hetzner-staging/.env \
  -f deployment/hetzner-staging/compose.yml \
  -f deployment/hetzner-staging/compose.actions-runner.yml \
  --profile steward \
  --profile actions-runner \
  up -d actions-dind actions-runner
```

## Post-Deploy Verification

Run:

```bash
deployment/hetzner-staging/scripts/post-deploy-check.sh
```

This check verifies Forgejo HTTP, identity bootstrap state, Merge Steward
health/readiness/discovery/OpenAPI/metrics, deployment doctor output, and the
workflow, project board, merge queue, release readiness, agent insights,
repository protection, agent capacity, agent performance, agent routing, agent
cockpit, action plan, agent submission gate, search, work pages, fleet coordination,
work context, CI failure analysis, PR brief, review assignment, patch conflict
prediction, and agent inbox APIs.
It writes a private receipt to
`$ELIZA_ARTIFACT_ROOT/eliza-hub-post-deploy-evidence.json` by default,
including every check name, pass/fail status, target URLs, timestamps, and
warning counts. Keep that receipt with the deploy evidence and release
checklist; it is the host-side proof that the deployed product surface was
verified after the service change.
Set
`MERGE_STEWARD_SMOKE_REPO` and
`MERGE_STEWARD_SMOKE_AGENT` if the staging smoke repo or agent id differs from
the defaults.

If this is the first boot or the OIDC source was rotated, verify identity
bootstrap directly:

```bash
APPLY_BOOTSTRAP=false deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh
```

The verifier writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json`; keep that
receipt with the release artifacts and pass it to `sso-evidence.mjs`.

If the runner is enabled:

```bash
deployment/hetzner-staging/scripts/check-actions-runner.sh
```

Then verify `.forgejo/workflows/runner-smoke.yml` through the Forgejo API. Do
not enable agent PR workflows until the `runner-smoke` job passes and required
checks are visible to Merge Steward. Generate the private runner evidence after
the smoke workflow and operator reviews pass:

```bash
RUNNER_SMOKE_DISPATCH=true \
RUNNER_EGRESS_REVIEWED=true \
RUNNER_SECRET_EXPOSURE_REVIEWED=true \
deployment/hetzner-staging/scripts/runner-evidence.sh
```

## Rollback Triggers

Rollback if any of these are true after a deploy:

- Forgejo healthcheck does not recover.
- Forgejo recovery admin, Eliza Cloud OIDC source, or steward token owner check
  fails.
- Merge Steward `/ready` fails or runtime preflight is not ok.
- Merge Steward migrations fail.
- Prometheus page-severity alerts fire for readiness, persistence, or worker
  lease safety.
- The isolated runner cannot pass its checks.
- A required smoke workflow cannot run on the `docker` label.

## Rollback Procedure

1. Disable new agent-driven merge execution:

   ```bash
   MERGE_STEWARD_WORKER_ENABLED=false
   MERGE_STEWARD_INTEGRATION_DRY_RUN=true
   ```

2. Restore the previous private `.env` image tags from the pre-release record.

3. Stop the runner first if Actions are contributing to the incident:

   ```bash
   docker compose --env-file deployment/hetzner-staging/.env \
     -f deployment/hetzner-staging/compose.yml \
     -f deployment/hetzner-staging/compose.actions-runner.yml \
     --profile actions-runner stop actions-runner actions-dind
   ```

4. Recreate Forgejo and Merge Steward with the previous images:

   ```bash
   docker compose --env-file deployment/hetzner-staging/.env \
     -f deployment/hetzner-staging/compose.yml \
     --profile steward up -d --force-recreate forgejo merge-steward
   ```

5. Run post-deploy verification again:

   ```bash
   deployment/hetzner-staging/scripts/post-deploy-check.sh
   ```

6. If the database or repository state is corrupted, restore only onto an empty
   replacement staging host from the verified backup. Do not overwrite the live
   host in place.

7. Keep the worker disabled until the failed release is understood and a new
   release gate passes.

## Roll-Forward Preference

Prefer rolling forward for stateless theme, docs, runner config, and steward
application fixes when the database is healthy. Prefer rollback for failed
migrations, persistent readiness failures, or runner isolation regressions.
