# AWS retirement plan

Living audit of AWS dependencies in this repo, what they do, what they were
migrated to (or kept and redirected), and what is still outstanding.

Pair this with [`RAILWAY.md`](./RAILWAY.md) (where central services run today)
and the storage notes in
[`../../cloud-shared/src/lib/storage/s3-compatible-client.ts`](../../cloud-shared/src/lib/storage/s3-compatible-client.ts)
(how the S3 SDK is pointed at Cloudflare R2 / Supabase / generic S3
endpoints).

## TL;DR

We are retiring AWS as a primary backend. The replacements per surface:

| AWS service | Replacement |
|---|---|
| S3 | Cloudflare R2 (via `@aws-sdk/client-s3` against R2 endpoint) |
| KMS | `LocalKMSProvider` (AES-256-GCM with `SECRETS_MASTER_KEY`) |
| ECS / EKS containers | Hetzner via `container-control-plane` |
| Lambda | Cloudflare Workers (`cloud-api`, `gateway-*`) |
| RDS | Neon Postgres |
| ElastiCache | Upstash Redis (managed) / `redis` package |
| CloudFront / Route53 | Cloudflare (Pages + DNS) |
| SQS / SNS | Not currently used in core services |

## Classification

### (K) Keep — provider-agnostic, points at non-AWS backend

| Dependency | Where | Why kept |
|---|---|---|
| `@aws-sdk/client-s3` | `packages/cloud-shared` | S3 wire protocol is the de-facto standard for object storage. `s3-compatible-client.ts` resolves `STORAGE_PROVIDER` (r2, supabase, s3) and points the client at R2 (`*.r2.cloudflarestorage.com`), self-hosted Supabase, or any generic S3 endpoint. There is no AWS S3 account in the production path. |
| `@aws-sdk/client-kms` | `packages/cloud-shared/src/lib/services/secrets/encryption.ts` | Lazy-loaded inside `AWSKMSProvider`. Default is `LocalKMSProvider` (AES-256-GCM with `SECRETS_MASTER_KEY`). The AWS provider is only constructed when `AWS_KMS_KEY_ID` is set — kept so existing deployments with a provisioned KMS key continue to decrypt their secrets. New deployments use `LocalKMSProvider`. |
| `packages/examples/aws/` | Examples package | A documentation example showing how to run an elizaOS worker on AWS Lambda + API Gateway. Not part of Eliza Cloud infrastructure. Keep as a user-facing example. |
| `s3-storage` plugin registry entry (`AWS_*` config fields) | `packages/app-core/src/registry/entries/plugins/s3-storage.json` | Generic user-facing S3 plugin. The `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_ENDPOINT` schema fields are how the broader S3 ecosystem labels these creds, regardless of provider. Keep. |
| `plugin-sql/src/config.toml` references to `AWS_ACCESS_KEY_ID` | Generic Supabase/S3 storage config | Same reason — config keys are the standard names. Keep. |
| `plugin-registry` env-var prefix allowlist (`AWS_`) | `plugins/plugin-registry/src/api/app-plugins-routes.ts` line 321 | Catch-all prefix used to identify infra credentials for any provider that uses `AWS_*` env names (R2, MinIO, etc). Keep. |

### (M) Migrate — actual AWS dependency that should leave

| Dependency | Where | Target | Status |
|---|---|---|---|
| `gateway-discord` EKS deployment | `packages/cloud-services/gateway-discord/terraform/` (~1.6k LOC) and `.github/workflows/cloud-gateway-discord.yml` | Railway (`railway.toml` + Dockerfile) or Hetzner via `container-control-plane`. Service is already a Bun/Docker app. | **Pending.** Out-of-scope for this audit (>2h work to write the Railway path, migrate state, and dual-deploy). Kept active until a Railway deploy lands. Owner: cloud-infra. |
| `TERRAFORM_AWS_ROLE_ARN` / `GATEWAY_AWS_ROLE_ARN` GitHub secrets | CI vars | Remove once gateway-discord EKS is decommissioned. | Pending on EKS retirement above. |

### (D) Delete — legacy / unreachable

| Path | Lines | Why | Status |
|---|---|---|---|
| `packages/cloud-infra/cloud/terraform/legacy-gateway-discord-aws/` | 19 files / ~1.9k LOC | Explicitly named "legacy"; duplicate of `cloud-services/gateway-discord/terraform/`; quarantined per the parent README. | **Deleted in this PR.** |
| AWS ECR/ECS client code (formerly `packages/cloud-shared/src/.../ecr.ts`, `ecs.ts`) | n/a | Already removed before this audit (no `client-ecr` / `client-ecs` imports remain). | **Already gone.** README references in `packages/cloud-shared/README.md` (lines 31, 42, 108, 164, 226-227, 280, 349-350) are stale and should be pruned in a follow-up README pass. |

## Outstanding AWS dependencies

| Item | Reason kept | Plan | Owner |
|---|---|---|---|
| `cloud-services/gateway-discord/terraform/` (EKS) | Active production deployment path for the gateway-discord pods | (1) Write `railway.toml` + healthcheck for gateway-discord. (2) Dual-deploy and verify against Discord bots. (3) Cut over DNS. (4) Delete terraform, helm chart's AWS bits, and the AWS jobs in `.github/workflows/cloud-gateway-discord.yml`. | cloud-infra |
| `.github/workflows/cloud-gateway-discord.yml` AWS OIDC + EKS deploy jobs | Drives the active EKS deployment | Remove once the Railway path above is live. | cloud-infra |
| `@aws-sdk/client-kms` retention | Existing deployments may have provisioned KMS keys | Document `LocalKMSProvider` rotation procedure; once all known deployments have rotated off AWS KMS, remove `AWSKMSProvider` class and drop the dep. | cloud-shared |
| `cloud-shared/README.md` AWS ECS/ECR references | Stale documentation pointing at code that no longer exists | Prune the references; small README PR. | cloud-shared |

## Staged retirement plan

1. **Now (this PR):**
   - Delete `legacy-gateway-discord-aws/` quarantined terraform copy.
   - Update `cloud-infra/cloud/terraform/README.md` to reflect the deletion.
   - Extend `RAILWAY.md` with the AWS retirement table.
   - Publish this `AWS_RETIREMENT.md`.

2. **Stage 1 — gateway-discord on Railway:**
   - Add `packages/cloud-services/gateway-discord/railway.toml`.
   - Verify the existing Dockerfile builds on Railway.
   - Smoke-test against a non-prod Discord bot.
   - Document in `RAILWAY.md`.

3. **Stage 2 — cut over:**
   - Move DNS / token routing to the Railway service.
   - Decommission EKS cluster via `terraform destroy` from
     `cloud-services/gateway-discord/terraform/`.
   - Delete the terraform directory and the AWS portions of
     `.github/workflows/cloud-gateway-discord.yml`.
   - Remove `TERRAFORM_AWS_ROLE_ARN` and `GATEWAY_AWS_ROLE_ARN` from CI vars.

4. **Stage 3 — KMS sunset:**
   - Confirm no production secret is still encrypted under an AWS KMS-derived
     DEK (or rotate the affected secrets through `SecretsEncryptionService.rotate`).
   - Remove `AWSKMSProvider` from `encryption.ts` and drop
     `@aws-sdk/client-kms` from `cloud-shared/package.json`.

5. **Stage 4 — paper cleanup:**
   - Prune AWS ECS/ECR references from `packages/cloud-shared/README.md`.
   - Audit comments in `packages/cloud-api/wrangler.toml` and remove the
     AWS-only secret docs once Stage 3 is done.

## Verification

The Phase 5 checks from the audit:

```bash
# Remaining AWS SDK deps — all justified in this doc.
rg "@aws-sdk/" --type json | grep -v node_modules | grep -v "/dist/"

# Remaining hard AWS env vars — only the three KMS-related ones in
# encryption.ts (justified above) and stale workflow/README references
# (tracked in the outstanding table).
rg "AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)" -g '!node_modules' \
  -g '!dist' -g '!*.lock' --type ts --type toml --type yml
```

Each remaining hit corresponds to a row in this document.
