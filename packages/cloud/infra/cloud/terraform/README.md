# Package Infra Terraform

This package-level Terraform root is not an active deployment source.

- The canonical Gateway Discord deployment terraform lives in
  `cloud/services/gateway-discord/terraform` (AWS / EKS). It is being retired
  as part of the AWS → Railway/Hetzner migration. See
  [`../AWS_RETIREMENT.md`](../AWS_RETIREMENT.md) for the staged retirement
  plan and current owner per stage.
- The previous package-level duplicate AWS copy in
  `legacy-gateway-discord-aws/` has been **deleted** (was a stale duplicate of
  the gateway-discord terraform, ~1.9k lines of dead Terraform).
- The `gcp/` roots are partial and are not wired to any CI workflow in this
  repository. Treat them as experimental until a consumer is added and
  documented.

Do not run Terraform from this directory expecting Gateway Discord
infrastructure to change.

## Current deployment topology

See [`../RAILWAY.md`](../RAILWAY.md) for the canonical map of where each
service runs today. Short version:

- `cloud-frontend` → Cloudflare Pages.
- `cloud-api` → Cloudflare Worker.
- `headscale` → Hetzner control-plane VM (agent path); `tunnel-proxy` → Railway (customer-tunnel path).
- `gateway-discord`, `gateway-webhook` → Docker (target: Railway).
- `agent-server`, per-customer compute → Hetzner via
  `container-control-plane`.
- Database → Neon (Postgres) — ONE shared DB per env (prod `ep-wild-smoke`,
  staging `ep-wild-dawn`); Steward is an embedded `steward` schema in that same
  shared DB, not a separate DB. Per-agent Neon branches are legacy/retired.
- Object storage → Cloudflare R2 (S3-compatible).
- Secrets/KMS → local AES-256-GCM with `SECRETS_MASTER_KEY`; optional AWS
  KMS provider retained for callers that have already provisioned a key.

## What lives here today

- `gcp/` — partial GKE / foundation modules, not currently wired to CI. Keep
  for future GCP experimentation.
- `hetzner/` — active control-plane, shared-app, and data-plane roots.
- `cloudflare/pages-domains/` — active environment-scoped Pages custom-domain,
  DNS, and certificate bindings for the console and app projects.

Wrangler still owns Cloudflare Worker routes and Pages deployments; the
Cloudflare Terraform root owns only the stable public edge bindings.
