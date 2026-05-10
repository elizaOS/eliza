# Eliza Cloud Staging

Staging is the `develop` branch environment. A successful `develop` push should:

1. run the cloud test/build workflows,
2. deploy the Worker to `api-staging.elizacloud.ai`,
3. deploy the Pages app from the `develop` branch to `staging.elizacloud.ai`,
4. run staging smoke checks, and
5. after every observed workflow for that commit is green, dispatch the beta release workflow.

## Domains

| Surface | Staging value |
| --- | --- |
| Web app | `https://staging.elizacloud.ai` |
| API Worker | `https://api-staging.elizacloud.ai` |
| R2 public host | `https://blob-staging.elizacloud.ai` |
| Agent base domain | `agents-staging.elizacloud.ai` |

Cloudflare must have the Pages custom domain, Worker route, R2 public host, and agent wildcard DNS configured for these names.

## Isolated Resources

Staging must not point at production resources. Configure separate staging resources for:

- Neon/Postgres: `DATABASE_URL`
- Upstash Redis/cache: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`
- R2 bucket: `eliza-cloud-blob-staging`
- Stripe test-mode keys, webhook secret, and price/product IDs
- Steward staging tenant/session/master/platform keys. The public staging tenant id is `elizacloud-staging`; set the Worker `STEWARD_TENANT_ID`, `STEWARD_DEFAULT_TENANT_ID`, and related tenant keys to the matching staging tenant.
- Container/provisioning sidecars and their control-plane tokens
- OAuth callback origins for Google, Discord, GitHub, Twitter/X, Microsoft, and WalletConnect

The generic Worker cache singleton is still disabled with `CACHE_ENABLED=false` because it is not yet safe across Cloudflare Worker request I/O contexts. Staging still uses the staging Upstash Redis for SIWE nonces, queues, rate limits, and credit events through the per-request Redis clients.

## Setup Commands

Create the staging R2 bucket once:

```bash
cd cloud/apps/api
bunx wrangler r2 bucket create eliza-cloud-blob-staging
```

Push staging Worker secrets from a staging-only dotenv file:

```bash
cd cloud
bun run cf:secrets:put:staging ./.env.staging
```

Run staging migrations against the staging database:

```bash
cd cloud
DATABASE_URL="postgresql://staging-url?sslmode=require" bun run db:migrate
```

Do not reuse `cloud/.env` for staging unless it has been audited to contain only staging credentials. Local ignored env files are allowed, but production-shaped values must stay out of the staging setup.

## GitHub Actions

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required GitHub environments:

- `staging`: database migration secrets point to staging services.
- `production`: database migration secrets point to production services.

Optional repository variables:

- `AUTO_BETA_RELEASE_FROM_DEVELOP`: set to `false` to keep the staging gate green without dispatching `release.yaml`.
- `DEVELOP_STAGING_GATE_TIMEOUT_SECONDS`: defaults to `3600`.
