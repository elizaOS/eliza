# AWS retirement — historical record

Audit of the AWS dependencies this repo carried, what each was migrated to
(or kept and redirected), and what is still outstanding. The retirement is
**complete** except the two rows in the Outstanding table below: the KMS
sunset (Stage 3) and deleting the stale `TERRAFORM_AWS_ROLE_ARN` /
`GATEWAY_AWS_ROLE_ARN` variables from the GitHub environments (an org-admin
console action; no code references them). Treat every other table here as a
record of finished work, not a plan. Where a replacement itself moved on
(the DB went AWS → Neon → Railway), the current home is what
[`RAILWAY.md`](./RAILWAY.md) says — that file is the canonical topology map.

Pair this with the storage notes in
[`../../shared/src/lib/storage/s3-compatible-client.ts`](../../shared/src/lib/storage/s3-compatible-client.ts)
(how the S3 SDK is pointed at Cloudflare R2 / Supabase / generic S3
endpoints).

## TL;DR

AWS is retired as a primary backend. Where each surface landed:

| AWS service | Replaced by (current state) |
|---|---|
| S3 | Cloudflare R2 (via `@aws-sdk/client-s3` against the R2 endpoint) |
| KMS | `LocalKMSProvider` (AES-256-GCM with `SECRETS_MASTER_KEY`); `AWSKMSProvider` deprecated, pending removal (Stage 3) |
| ECS / EKS containers | Hetzner data-plane containers (provisioning worker + `docker_nodes`); gateways on Railway |
| Lambda | Cloudflare Worker (`eliza-cloud-api`); the `gateway-*` services run on Railway, not Workers |
| RDS | Railway managed Postgres (interim Neon deployment retired — `wrangler.toml` marks `NEON_API_KEY` retired) |
| ElastiCache | Railway managed Redis (TCP `REDIS_URL`); Upstash REST kept only as a legacy fallback |
| CloudFront / Route53 | Cloudflare (Pages + DNS) |
| SQS / SNS | Not used in core services (Stripe webhook fan-out runs on Redis; see `wrangler.toml`) |

## Classification

### (K) Keep — provider-agnostic, points at non-AWS backend

| Dependency | Where | Why kept |
|---|---|---|
| `@aws-sdk/client-s3` | `packages/cloud/shared` | S3 wire protocol is the de-facto standard for object storage. `s3-compatible-client.ts` resolves `STORAGE_PROVIDER` (r2, supabase, s3) and points the client at R2 (`*.r2.cloudflarestorage.com`), self-hosted Supabase, or any generic S3 endpoint. There is no AWS S3 account in the production path. |
| `@aws-sdk/client-kms` | `packages/cloud/shared/src/lib/services/secrets/encryption.ts` | Lazy-loaded inside `AWSKMSProvider`. Default is `LocalKMSProvider` (AES-256-GCM with `SECRETS_MASTER_KEY`). The AWS provider is only constructed when `AWS_KMS_KEY_ID` is set — kept so existing deployments with a provisioned KMS key continue to decrypt their secrets. New deployments use `LocalKMSProvider`. |
| `packages/examples/aws/` | Examples package | A documentation example showing how to run an elizaOS worker on AWS Lambda + API Gateway. Not part of Eliza Cloud infrastructure. Keep as a user-facing example. |
| `s3-storage` plugin registry entry (`AWS_*` config fields) | `packages/app-core/src/registry/entries/plugins/s3-storage.json` | Generic user-facing S3 plugin. The `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_ENDPOINT` schema fields are how the broader S3 ecosystem labels these creds, regardless of provider. Keep. |
| `plugin-sql/src/config.toml` references to `AWS_ACCESS_KEY_ID` | Generic Supabase/S3 storage config | Same reason — config keys are the standard names. Keep. |
| `plugin-registry` env-var prefix allowlist (`AWS_`) | `plugins/plugin-registry/src/api/app-plugins-routes.ts` line 321 | Catch-all prefix used to identify infra credentials for any provider that uses `AWS_*` env names (R2, MinIO, etc). Keep. |

### (M) Migrate — actual AWS dependency that should leave

| Dependency | Where | Target | Status |
|---|---|---|---|
| `gateway-discord` EKS deployment | `packages/cloud/services/gateway-discord/terraform/` and `.github/workflows/cloud-gateway-discord.yml` | Railway (`railway.toml` + Dockerfile). Service is already a Bun/Docker app. | **Done.** `terraform/` and `chart/` removed; `railway.toml` added; workflow stripped of all AWS jobs (terraform plan/apply/destroy, EKS update-kubeconfig, ECR/Helm deploy). Workflow now only runs tests; Railway auto-deploys on push. |
| `gateway-webhook` EKS deployment | `packages/cloud/services/gateway-webhook/` | Railway. | **Done.** No `terraform/` directory existed; `railway.toml` is in place; workflow has no AWS jobs. |
| `TERRAFORM_AWS_ROLE_ARN` / `GATEWAY_AWS_ROLE_ARN` GitHub secrets | CI vars | Remove from the `gateway-dev` / `gateway-prd` environments now that the workflow no longer references them. | **Ready for removal.** Workflow no longer reads either variable; the env-vars in the GitHub environments themselves should be deleted by a maintainer with org-admin access. |

### (D) Delete — legacy / unreachable

| Path | Lines | Why | Status |
|---|---|---|---|
| `packages/cloud/infra/cloud/terraform/legacy-gateway-discord-aws/` | 19 files / ~1.9k LOC | Explicitly named "legacy"; duplicate of `packages/cloud/services/gateway-discord/terraform/`; quarantined per the parent README. | **Done.** |
| `packages/cloud/services/gateway-discord/terraform/` and `chart/` | Active EKS terraform + Helm chart | Replaced by `railway.toml`. | **Done.** |
| AWS ECR/ECS client code (formerly `packages/cloud/shared/src/.../ecr.ts`, `ecs.ts`) | n/a | No `client-ecr` / `client-ecs` imports remain. | **Done.** |
| `packages/cloud/shared/README.md` stale AWS ECS/ECR/EKS/CloudFormation/CloudWatch refs | Documentation only | Replaced with Hetzner / container-control-plane / Railway language. | **Done.** |

## Outstanding AWS dependencies

| Item | Reason kept | Plan | Owner |
|---|---|---|---|
| `@aws-sdk/client-kms` retention | Existing deployments may have provisioned KMS keys | `AWSKMSProvider` is now marked `@deprecated` and emits a `logger.warn` on first use. Rotate all known production secrets through `SecretsEncryptionService.rotate()` under `LocalKMSProvider`, then remove the class and drop the dep. | cloud-shared |
| `TERRAFORM_AWS_ROLE_ARN` / `GATEWAY_AWS_ROLE_ARN` environment vars in GitHub | CI vars in the `gateway-dev` / `gateway-prd` environments | Workflow no longer references them; delete from GitHub environment settings. | cloud-infra |

## Staged retirement plan

1. **Stage 0 — Audit + quarantine cleanup (done):**
   - Deleted `legacy-gateway-discord-aws/` quarantined terraform copy.
   - Updated `packages/cloud/infra/cloud/terraform/README.md` to reflect the deletion.
   - Extended `RAILWAY.md` with the AWS retirement table.
   - Published this `AWS_RETIREMENT.md`.

2. **Stage 1 — gateway-discord on Railway (done):**
   - `packages/cloud/services/gateway-discord/railway.toml` in place.
   - Existing Dockerfile builds on Railway.

3. **Stage 2a — gateway-webhook on Railway (done):**
   - `packages/cloud/services/gateway-webhook/railway.toml` in place.
   - `cloud-gateway-webhook.yml` workflow contains no AWS jobs.

4. **Stage 2b — gateway-discord cutover (done):**
   - `terraform/` and `chart/` directories deleted from `packages/cloud/services/gateway-discord/`.
   - All AWS-specific jobs removed from `.github/workflows/cloud-gateway-discord.yml`
     (terraform plan/apply/destroy, AWS OIDC, EKS update-kubeconfig, Helm deploy,
     image build job that fed the EKS path).
   - Remaining task: maintainer with org-admin to remove
     `TERRAFORM_AWS_ROLE_ARN` and `GATEWAY_AWS_ROLE_ARN` from the `gateway-dev` /
     `gateway-prd` GitHub environments. No code references them.

5. **Stage 3 — KMS sunset (in progress):**
   - `AWSKMSProvider` is now annotated `@deprecated` with a migration recipe in
     the JSDoc and emits a `logger.warn` on first construction pointing to this
     document.
   - Outstanding: rotate any remaining production secrets that were encrypted
     under an AWS KMS-derived DEK through `SecretsEncryptionService.rotate()`
     once `SECRETS_MASTER_KEY` is set, then remove `AWSKMSProvider` and drop
     `@aws-sdk/client-kms` from `packages/cloud/shared/package.json`.

6. **Stage 4 — paper cleanup (done):**
   - All AWS ECS/ECR/EKS/CloudFormation/CloudWatch references pruned from
     `packages/cloud/shared/README.md` (TOC, feature list, architecture
     diagrams, schema docs, troubleshooting, additional-resources links).
   - Container deployment documentation now points at
     `packages/cloud/services/container-control-plane` (Hetzner) and `RAILWAY.md`.

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
