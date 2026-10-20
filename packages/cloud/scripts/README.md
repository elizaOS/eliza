# Cloud tooling

Private operational and test scripts for Eliza Cloud. The package declares its
workspace imports locally so they do not invalidate unrelated build caches.
Invoke operations through their documented root commands; run the script test
lane with `bun run test:scripts` from the repository root.

Gateway deployment, verification, homepage readiness, and DNS operations belong
here. Invoke them with `bun run --cwd packages/cloud/scripts sms-gateway:verify:cloud-prod`
or the corresponding `sms-gateway:*` command in this package. Device installation
and pairing remain in the app package.

Run Cloud Latency Certification from `staging` for staging or `main` for
production. Select the matching environment and exact served commit. Both use
`qwen-3.8-27b@high@max` by default and retain sanitized request traces. Auth cache
probes are available only in staging. Production uses the protected production
environment and the root Worker placement policy from the deployed commit.

The staging database identity report can query the recorded Hetzner server IDs
for agents blocked by migration 0398. Enable `read_only_agent_provider_state` to
emit hashed subjects and provider-state comparisons. A server absent from the
configured project does not establish historical billing or authorize a repair.

## Staging 0398 deletion row repair

Migration 0398 refuses to run while an agent in `deletion_pending` or
`deletion_failed` lacks pre-deletion billing authority. On staging, one legacy
failed deletion had no captured previous status or billing status, no compute
funding and no provider stop record, and its server no longer existed. The
owner approved retiring that row. `Cloud staging deletion row repair`
(`.github/workflows/cloud-staging-deletion-row-repair.yml`) does this:

1. Dispatch it from `staging` with `expected_cloud_commit` set to the staging
   head and `mode=dry-run`. It lists the rows the migration guard reports (ID
   and lifecycle fields only) in a read-only transaction.
2. Dispatch `mode=apply` with that `agent_id` and a `reason`. In one
   transaction it checks the pinned staging database identity, locks the
   guard's tables, requires the guard to report exactly that row in the
   approved state (`deletion_failed`, null previous status and billing status,
   no funding, no stop intent), sets `deleted_at` on exactly one row, requires
   the guard to report zero rows, and commits. The receipt, with the reason, is
   kept as a 90-day artifact and in the job summary.

Only `deleted_at` and `updated_at` change, so no billing segment is written.
The script (`admin/staging-deletion-row-repair.ts`) refuses to run unless
`GITHUB_REF` is `refs/heads/staging`, the operator environment is staging and
the database identity matches `admin/staging-database-identity-pin.ts`. Confirm
the result with the database identity staging report
(`read_only_deletion_billing_provenance`).

## Staging grant codes

`Cloud staging mint grant codes`
(`.github/workflows/cloud-staging-mint-grant-codes.yml`) mints subscription
grant codes on staging without exposing them to CI. Generate a key pair
locally, dispatch from `staging`, then open the one-day artifact locally:

```sh
bun packages/cloud/scripts/admin/recipient-envelope.ts keygen --private-out key.pem --public-out key.pub.b64
gh workflow run cloud-staging-mint-grant-codes.yml --ref staging \
  -f expected_cloud_commit=<staging head> -f recipient_public_key="$(cat key.pub.b64)"
gh run download <run id> --name staging-grant-codes-sealed-<run id>-1 --dir sealed
bun packages/cloud/scripts/admin/recipient-envelope.ts open --private-key key.pem < sealed/grant-codes.envelope.json > codes.txt
```

The mint script's stdout is piped only into the sealer (RSA-OAEP-256 wrapping
an AES-256-GCM key), and only the sealed envelope is uploaded. Defaults: 5
single-use `alpha-staging-qa` codes and one 50-redemption `alpha-staging-shared`
code, 183 days each. The pepper is the staging Environment secret
`ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER`. Delete the artifact after download.

## Production test grant

`Cloud production test grant` runs only on an exact reviewed `main` commit and
uses the protected `production` Environment. Its default run reads only database
identity and column metadata. The existing reviewed cluster and authority digest
variables must match; missing variables refuse the run. It reports booleans or
fixed error codes, without database names, credentials, SQL parameters or grants.

Explicit `mint=true` issues exactly one single-use Plus grant, with 7 days by
default and a maximum of 31 days. It refuses redemption by an organization with
an open paid plan. The unredeemed code expires after one day. The mint transaction
rechecks production identity and migration 0547 columns on its own database
session. This does not apply migrations or change Stripe objects.

Supply the recipient public key made by `recipient-envelope.ts keygen`, as in
the staging procedure above. Only the sealed envelope is uploaded for one day.
Open it locally with the matching private key. Never put plaintext codes in logs
or issue comments. The workflow is not a payment, redemption, or service-acceptance
check. Do not dispatch the staging workflow against production.

## Production pending migration review

The read-only `Production Railway Database Authority Audit` reports
`pendingMigrationTags` for the canonical and protected database connections.
These are ordered tags from the checked-out migration journal, mapped only after
ledger hashes and order pass validation and both database authorities match.
An empty array means the validated ledger is current. `null` means that no plan
was admitted (missing, divergent, unavailable or mismatched authority). A pending
list still fails readiness; it does not authorize a migration or prove that the
served application supports the new schema. The workflow retains its exact-main
freshness check and prints no database identities, credentials or customer rows.

The authority report exposes the already-read server major as `18`, `other`, or
`unavailable`. A passing authority check already requires PostgreSQL 18 on both
connections. The optional backup report separates that live observation from
service-image metadata. It reports PITR enabled/bucket/blocker booleans, known
blocker kinds, and a fixed live-probe category. Unknown provider errors remain
unknown; raw image names, blocker text and SSH errors are never published.
These observations do not relax any readiness check or authorize a restore.

The optional `restore_target_utc` dispatch input adds read-only backup evidence
for one fixed past UTC time (`YYYY-MM-DDTHH:MM:SSZ`). Leave it empty to retain the
existing audit behavior. The same pinned Railway 5.38.0 CLI captures private
volume, PITR, schedule and backup metadata. The existing resilience evaluator is
enforced for this report even if the release gate is off. Its backup-age policy
uses the same protected setting and 36-hour fallback as the release workflow.

The report checks protected authority, volume binding, backup freshness, live
archiver health and whether the target falls within the observed CLI window.
Railway's live window is best-effort: a passing candidate does not prove archive
continuity or restore success. `archiveContinuityProven`, `restoreProven` and
`productionMigrationReady` remain false. Only booleans and receipt hashes are
published; raw files are destroyed after the run. The audit can report backup
observations while its existing divergent-ledger readiness still fails. No
backup, restore, configuration change or database write occurs.

For a divergent ledger, `migrationLedgerDiagnostics` reports a fixed reason and
a canonical tag only when the journal uniquely identifies it. Raw database row
IDs, timestamps, hashes and exception messages are excluded. Unknown failures
remain classified as `unknown`; neither case admits a pending plan or a repair.

If matching authorities expose a migration0387 hash mismatch, the same
read-only audit also reports `funding0387`. The stored hash is compared privately
with two source-verified variants: `historical` (commit57d9e8062404af41c903d34ec1599b9b743ddd6a)
and `canonical`. It returns no stored hash. Unknown variants do not yield ledger admission; query errors yield no schema flags. This extra probe runs when either ledger reports a0387 hash
mismatch; it never changes the failed ledger verdict or produces a pending plan.

For each variant, schema flags compare reviewed column types, nullability,
default expressions and generated/identity status; constraint definitions and
validation status; and index definitions, readiness, validity and uniqueness.
Unexpected catalog objects are reported only as booleans, never by name. The
expected definitions come from isolated PGlite databases created from the exact
historical/current SQL. PostgreSQL catalog rendering differences can cause a
mismatch; they cannot authorize repair. Later additive migrations can also make
an exact0387-only schema comparison false. Catalog flags are labeled `schemaPurpose: diagnostic_only`, including when the
stored hash is unknown. They describe selected catalog objects only and never
prove migration identity or deployment readiness. Source, fixture, and row-count
guards still stop observation. The probe reads no funding rows and
prints no stored defaults, constraint expressions, IDs or connection details.
Neither a known variant nor matching schema flags authorize a ledger rewrite,
DDL, grant issuance or app deployment.

An unknown0387 variant has a fixed `reason`: `source_guard`, `fixture_guard`,
`ledger_row_count`, or `unknown_hash`. These distinguish source evidence failure,
unexpected row count, and an unrecognized stored hash without publishing the
count, stored hash, or database values. Known variants and unavailable queries
have a null reason. These diagnostics do not authorize any database change.

The diagnostic also reports funding relation presence and a fixed relation kind.
It compares the private ledger hash with this checkout's canonical migration
hashes. `hashAssociation` returns only a uniquely matched reviewed tag, or
`none`/`ambiguous` with no tag. A match to another tag describes a possible wrong
journal association; it never reassigns that row or proves the schema is ready.
Ledger validation maps stored timestamps to current journal entries before
checking hashes. It does not identify applied SQL from row position or tag text.

For an unknown0387 hash, the same transaction observes the complete ledger in
existing row order, up to10000 rows (larger ledgers fail closed, never truncate).
Each association contains only a uniquely reviewed timestamp tag and hash tag,
plus a fixed hash-match status. Counts describe unknown/ambiguous hashes;
`recognizedHashOrder` describes only uniquely matched hashes. Unobserved tags
include both gaps and never-applied tail entries: they are observations, not a
migration plan. Stored row IDs, timestamps and hashes are never published.
The Gmail receipt diagnostic checks fixed table presence/kind and the authentic
0509 function body/properties and trigger definition/enabled state. It reads no
receipt data and does not claim full table-schema or operational equivalence.

### Exact Gmail ledger recovery rehearsal primitives

`exact-gmail-ledger-recovery.ts` admits only the observed370-entry prefix plus
0509/0535 effects recorded at0387/0388 times. Its519-entry source fingerprint
pins journal entries, hashes and parsed statements for this one recovery. It is
not a generic migration limit or a relaxation of normal ledger validation.
There is no production entry point or runnable production repair command.

The transaction boundary requires an exclusively owned idle connection, actual
PostgreSQL command tags and protocol transaction status. Work must not issue
transaction control or share the connection. Lost commit replies stay uncertain;
no automatic retry or speculative rollback is performed after commit submission.

The Gmail catalog fixture covers authentic0509+0535 and requires an explicit
reviewed table/function owner-role policy. Actual server major selects either the PGlite 17.5 fixture or the pinned
PostgreSQL 18 fixture. Other versions are refused. The PG18 fixture retains
its eight explicit NOT NULL constraints and constraint enforcement flags. Default ACLs are required by this fixture;
nondefault deployment grants need explicit review, not silent acceptance.
Preexisting0500 retirement relations are refused because the observed ledger
contains no retirement evidence. Synthetic tests prove frozen balances and
rollback boundaries. The PG18 synthetic run also exercises the complete
147-migration recovery; it does not establish live acceptance.

The local-only `admin/run-local-gmail-recovery.py` launcher uses a pinned PG18
image already present in Docker. It creates an owned loopback container with
synthetic credentials, a 1 GiB temporary data filesystem, a 3 GiB memory limit,
and a 22 GiB free-disk reserve. Bun runs with `--no-env-file` and a cleared
provider environment. It never accepts an external database URL. Choose a fresh
ignored `test-results/` output directory and pass the absolute Bun 1.4.2 path:

```sh
python3 packages/cloud/scripts/admin/run-local-gmail-recovery.py \
  --bun /absolute/path/to/bun \
  --output test-results/gmail-recovery/run-unique
```

The synthetic worker builds the normal 370-entry baseline, adds the observed
Gmail anomaly and representative financial/Gmail rows, then exercises late SQL
failure rollback, partial retirement refusal, successful recovery and repeat
refusal. Its executor uses the same source/identity admission, advisory lock,
canonical SQL parser and validator, and a private exception archive. The pinned PG18 synthetic run passed: all 147 missing SQL migrations executed,
a real SQL failure after final ledger validation rolled them back, and the
successful recovery left the normal runner with no pending work. Server-side
ordered full-row hashes preserve microsecond timestamps and bigint values;
those private hashes never enter operator receipts.

Remaining gates: populated restore coverage beyond the synthetic financial
fixtures, uncertain-outcome read-only reconciliation, protected backup/restore
rehearsal, maintenance fencing and reviewed business impact. Production readiness
must remain failed until recovery and normal release verification pass.


The optional `pitr_provisioning_plan=true` input requires a fixed restore target.
It privately reads the existing environment config without decrypted variables,
the staged patch, and the pinned CLI's `postgres-pitr` template query. The report
contains only checks, counts and hashes. It distinguishes standalone topology,
retained backup metadata, image preservation and current staged changes. This
is a review plan, not permission to stage or deploy: provider `stageOnly` can
create resources, and the public staged-commit API has no compare-and-swap guard.
No mutation command is connected. Private plan evidence uses the existing cleanup.

The resilience evaluator can accept an exact approved image-string SHA256 with
matching resource-bound live PostgreSQL18 authority evidence. The approval must
come from reviewed protected configuration; current evidence cannot approve
itself. No workflow supplies this opt-in yet. A configured mismatch cannot fall
back to the tag check, and PITR/backup/readiness requirements remain unchanged.

The `pitr-reviewed-{stage,patch}.ts`, `pitr-backup-proof.ts`, and
`pitr-private-api.ts` modules prepare internal boundaries for this repair path.
They have no executable workflow or automatic operation. The fixed stage wrapper
binds the actual protected template receipt; its policy engine is separately
exercised with synthetic fixtures. Staging can allocate a bucket and always
requires subsequent private review. It never commits configuration. The exact
commit boundary permits reviewed WAL archive variables only, preserves the
original service/volume/image authority, and reports lost replies as unconfirmed.
Practical exclusive-writer maintenance remains necessary: these checks are not
provider atomic compare-and-swap. No automatic retry, restore, deletion, or
rollback is performed.

Backup proof requires an exact-volume unique named creation, provider workflow
`Complete`, and a new retained matching backup. A started workflow or backup-list
metadata alone is insufficient. Private API inputs use stdin, bounded captures,
finite errors, and owned process-group retirement. Production integration still
requires pinned CLI/source admission, fresh independent authority snapshots,
private durable intent/result storage, termination wiring, and actual staged WAL
reference/owned-bucket validation. These missing connections must be reviewed
before a runnable operator is introduced. This supports the production recovery
requirements; focused fixtures do not establish populated restore or migration
acceptance.

`production-pitr-safety-backup.yml` is the independently reviewable backup-only
entrypoint. It runs on canonical main in the protected production environment,
uses the checksum-pinned CLI, captures fresh read-only PG18 authority, and requires
the reviewed immutable volume-instance SHA256 and an explicit review expiry within
one hour. It publishes a hashed operation intent before creating one uniquely named
backup. Completion requires the actual provider workflow to complete and the new
exact-volume backup to remain retained at proof publication; safe receipts include
times and `noScheduledExpiry`, never provider IDs or credentials. A changed source,
expired authority/review, lost response or unconfirmed workflow stops without retry.
Private captures are destroyed in the final workflow step. This workflow has no
stage, commit, restore, deletion or database-write operation. A completed safety
backup is not an isolated populated restore rehearsal, and does not authorize the
subsequent provisioning or migration phases.

The named safety backup workflow also accepts `reconcile_operation_receipt`.
Set it to the exact operation-name SHA256 from an uncertain run to select a
read-only backup-list reconciliation. Keep the reviewed volume receipt and a
fresh review expiry. This mode never creates a backup and never falls back to
creation. A unique retained list entry does not prove provider workflow Complete;
no automatic retry, PITR stage or restore is authorized by its result.
Creation receipts distinguish the final preflight from an invoked provider API.
`requestSubmitted` records API invocation, not confirmed provider acceptance.

Transport failure receipts use finite categories for invocation failures, aborts,
timeouts, output limits, invalid JSON, HTTP status classes and allowlisted GraphQL
extension codes. Provider text, arbitrary codes and request values remain private.
A CLI nonzero exit always fails, even if its JSON includes data. An unknown refusal
stays unknown; no category establishes non-acceptance or permits automatic retry.
Reconciliation also observes the live backup mutation's argument and return-type
contract through fixed read-only introspection. It reports booleans only. Disabled
or malformed introspection does not discard the backup-list observation. Contract
agreement does not authorize creation. GraphQL document validation and provider
`BAD_USER_INPUT` now have distinct finite categories; no further create is needed
to inspect the deployed schema.
Reconciliation reports storage used and total MB from the same verified volume
instance, plus listed/retained backup counts. Pinned CLI5.38 labels
`currentSizeMB/sizeMB` as storage used/total. Missing, non-finite or impossible
amounts remain unknown. The above-half flag compares observed usage with Railway's
[documented manual-backup limit](https://docs.railway.com/volumes/backups).
It is diagnostic only: being below that limit does not prove creation eligibility,
and the operator never resizes a volume or retries a backup from this observation.
For a separately reviewed single reproduction, `error_recipient_public_key` can
select encrypted provider failure evidence. The existing RSA-OAEP/AES-GCM helper
validates the public recipient before backup creation. Only GraphQL error messages
and fixed code values are selected, with known request identifiers, operation name
and tokens scrubbed before encryption. At most16 messages of4096 characters and
64KiB of selected plaintext are accepted; oversized evidence is refused, not
truncated. Plaintext stays in memory. Only a ciphertext digest and finite status
enter the public receipt. The encrypted artifact has one-day retention and the
private working directory is cleaned even after failure. No response data, raw
stderr, arbitrary extensions or environment dump is captured. The private key
stays with the local operator. Evidence capture never retries or converts a failed
provider operation to success; it does not authorize stage, resize or migration.

### Bounded backup retention observations

The protected named-backup workflow's existing read-only reconciliation also reports at most 15 backup hash receipts, creation/expiry dates, scheduled/manual classification and finite sizes. It marks every tie for the newest valid creation time for preservation and distinguishes expired entries. Larger or ambiguous inventories refuse detailed output. Schedule metadata is limited to the provider enum, creation time and retention seconds; unavailable schedule observations do not invalidate reconciliation. No raw IDs, names, cron expressions or external IDs are printed. These observations support a concrete retention review; they do not authorize deletion/locking or prove backup completion/restorability. This production operator addition targets main because its protected workflow requires refs/heads/main, continuing user-authorized Cloud recovery; it does not change product runtime requirements or the MVP.
