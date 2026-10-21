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
code, 183 days each, family `alpha_phone`, plan `plus_monthly`. The pepper is
the staging Environment secret `ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER`. Delete
the artifact after download.

Optional inputs set the campaign: `family` (`alpha_phone` or `grace_pilot`),
`plan` (`plus_monthly` or `pro_monthly`), `duration_days` (1 to 731) or
`duration_months` (1 to 24, not both), `requires_no_paid_plan`, and
`expires_at` (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`, in the future). For
example, a Grace pilot wave of single-use codes:

```sh
gh workflow run cloud-staging-mint-grant-codes.yml --ref staging \
  -f expected_cloud_commit=<staging head> -f recipient_public_key="$(cat key.pub.b64)" \
  -f family=grace_pilot -f duration_months=6 -f requires_no_paid_plan=true \
  -f single_use_count=20 -f single_use_label=grace-pilot-wave-1 -f shared_max_redemptions=0
```

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
