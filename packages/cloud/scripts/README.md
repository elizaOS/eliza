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
