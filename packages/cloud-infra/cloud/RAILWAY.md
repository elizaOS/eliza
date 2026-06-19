# Railway deploy story

Where each piece of the Eliza Cloud backend actually runs today, and where it
is heading.

## Topology (current)

| Surface | Runtime | Repo path | Config |
|---|---|---|---|
| `cloud-frontend` (dashboard SPA) | Cloudflare Pages | `packages/cloud-frontend/` | Wrangler / Pages project |
| `cloud-api` (REST + auth + billing) | Cloudflare Worker | `packages/cloud-api/` | `apps/api/wrangler.toml` (env vars, secrets via `wrangler secret`) |
| `headscale` (Tailscale coordination server for agents + customer tunnels) | Hetzner control-plane VM | `packages/cloud-services/headscale/` | armed via `arm-headscale-control-plane.yml` (ACL `acl.hujson`) |
| `tunnel-proxy` (public HTTPS -> tailnet bridge, customer-tunnel path) | Railway | `packages/cloud-services/tunnel-proxy/` | `railway.toml`, `Dockerfile` |
| `bitrouter` (Eliza Cloud model router) | Railway | `packages/cloud-infra/cloud/bitrouter/` | `railway.toml`, `Dockerfile` |
| `gateway-discord` | Cloudflare Worker | `packages/cloud-services/gateway-discord/` | own `wrangler.toml` |
| `gateway-webhook` | Cloudflare Worker | `packages/cloud-services/gateway-webhook/` | own `wrangler.toml` |
| `agent-server` (per-customer agent runtime) | Hetzner containers | `packages/cloud-services/agent-server/` | provisioned via `container-control-plane` |
| `container-control-plane` (provisioning API) | Hetzner / VPS | `packages/cloud-services/container-control-plane/` | env-driven |
| Database migrations | GitHub Actions -> Neon (Postgres) | `packages/cloud-api/db/` | `.github/workflows/cloud-deploy-backend.yml` |

The deprecated agent VPS deploy still exists behind the
`deploy_legacy_vps` `workflow_dispatch` input on
`cloud-deploy-backend.yml`. It is **off by default** and only runs when an
operator explicitly opts in. New code should not target it.

## headscale (not Railway — Hetzner control-plane VM)

`headscale` is the Tailscale coordination server for both internal agents
(`tag:agent`) and customer tunnels (`tag:eliza-tunnel`). For the agent launch
path it runs **on the Hetzner control-plane VM**, not on Railway — the
provisioning worker and agent router talk to it over a private loopback API.
The previous Railway-hosted headscale runtime was decommissioned on 2026-06-17.

- Runtime: Hetzner control-plane VM (nginx + Let's Encrypt terminate TLS in
  front of local headscale).
- Public domain: `headscale.elizacloud.ai` → CP VM (DNS points at the
  control plane).
- ACL source of truth: [`packages/cloud-services/headscale/acl.hujson`](../../cloud-services/headscale/acl.hujson),
  deployed by `arm-headscale-control-plane.yml`.
- Provisioning runbook: [`packages/cloud-services/headscale/DEPLOY.md`](../../cloud-services/headscale/DEPLOY.md).

## Railway services in detail

### `tunnel-proxy`

- Builder: Dockerfile (Go binary).
- Healthcheck: `GET /health` (served by [`main.go`](../../cloud-services/tunnel-proxy/main.go) line 117).
- Volume: `/var/lib/tunnel-proxy` (tsnet node identity).
- Public domain: `tunnel.elizacloud.ai` + wildcard `*.tunnel.elizacloud.ai`.
- Provisioning runbook: [`packages/cloud-services/headscale/DEPLOY.md`](../../cloud-services/headscale/DEPLOY.md) (covers both services).

### `bitrouter`

- Builder: Dockerfile (`node:24-bookworm-slim` + npm `bitrouter`).
- Healthcheck: `GET /health` on the public auth proxy.
- Public auth: `Authorization: Bearer $BITROUTER_PROXY_TOKEN`; the proxy
  replaces it with an internal BitRouter JWT before forwarding to the local
  daemon.
- Cloud API config: `BITROUTER_BASE_URL=https://<railway-domain>` and
  `BITROUTER_API_KEY=<same value as BITROUTER_PROXY_TOKEN>`.
- Service runbook: [`packages/cloud-infra/cloud/bitrouter/README.md`](./bitrouter/README.md).

## Where Railway is heading

The strategic direction is to **retire AWS** and move central services to
Railway, with container-based workloads provisioned on Hetzner via the
`container-control-plane`. Concretely:

- Anything new that needs a long-running stateful HTTP service should target
  Railway. Add a `railway.toml` next to its `Dockerfile`, point the healthcheck
  at a real endpoint the service serves, and document it here.
- Anything new that is per-customer compute or GPU-bound should target Hetzner
  via `container-control-plane`.
- Anything that fits the edge model (stateless REST, low-latency, JWT-gated)
  should stay on Cloudflare Workers.
- AWS resources (legacy gateway-discord on AWS Lambda, S3 buckets, etc.) are
  being phased out. New AWS dependencies should not be added.

## AWS retirement summary

Full classification, plan, owners, and outstanding items live in
[`AWS_RETIREMENT.md`](./AWS_RETIREMENT.md). Quick map:

| AWS thing | Status | Target |
|---|---|---|
| `@aws-sdk/client-s3` (cloud-shared) | **Keep** | Cloudflare R2 / Supabase / generic S3 endpoint — SDK is provider-agnostic |
| `@aws-sdk/client-kms` (cloud-shared encryption) | **Keep (optional)** | `LocalKMSProvider` (AES-256-GCM with `SECRETS_MASTER_KEY`) is the default. AWS KMS provider only fires when `AWS_KMS_KEY_ID` is set |
| `legacy-gateway-discord-aws/` terraform | **Deleted** | n/a — was a stale duplicate |
| `cloud-services/gateway-discord/terraform/` (EKS) | **Retire** | Gateway-discord is a Docker/Bun service; redeploy on Railway / Hetzner. Terraform + CI workflow kept until Railway path lands. |
| `packages/examples/aws/` Lambda example | **Keep** | Documentation example for users who want to deploy elizaOS on Lambda. Not part of Eliza Cloud infra. |
| AWS ECR/ECS code | **Already removed** | Replaced by `container-control-plane` + Hetzner. README references are stale and have been pruned. |

## Removed: legacy fullstack `railway.toml`

`packages/cloud-infra/cloud/railway.toml` used to deploy the old Next.js
fullstack `cloud` app to Railway. Its healthcheck pointed at `/login`, a
Next.js page route. That deployment is gone: `cloud-frontend` is a Vite SPA on
Cloudflare Pages and `cloud-api` is a Cloudflare Worker. The file has been
removed; nothing in the repo or in CI referenced it.
