# Package Infra Terraform

Terraform roots for the Eliza Cloud edge and control plane. Active roots are
`hetzner/` and `cloudflare/pages-domains/`; the `gcp/` roots are experimental.

- The AWS/EKS Gateway Discord Terraform (both the service-local copy and the
  package-level `legacy-gateway-discord-aws/` duplicate) has been **deleted**
  as part of the completed AWS retirement — see
  [`../AWS_RETIREMENT.md`](../AWS_RETIREMENT.md). The gateways deploy on
  Railway from their own `railway.toml` manifests.
- The `gcp/` roots are partial and are not wired to any CI workflow in this
  repository. Treat them as experimental until a consumer is added and
  documented.

## Current deployment topology

See [`../RAILWAY.md`](../RAILWAY.md) for the canonical
service/runtime/request-path map. Short version:

- Frontends → Cloudflare Pages: `eliza-cloud` (apex) + `eliza-app`
  (`app.elizacloud.ai`), both built from `packages/app`.
- `eliza-cloud-api` → one Cloudflare Worker (REST API, auth, billing, model
  gateway, dedicated-agent proxy, batch voice routes).
- `gateway-discord`, `gateway-webhook`, `voice-kokoro-tts`,
  `voice-whisper-stt`, `tunnel-proxy` → Railway (Docker manifests in each
  service directory).
- `headscale` + the provisioning daemons → Hetzner control-plane VM
  (`hetzner/control-plane/` here); per-customer `agent-server` containers →
  Hetzner data-plane nodes (runtime-provisioned, not Terraform).
- Database → Railway managed Postgres (env-scoped `DATABASE_URL`; the Worker
  connects via Hyperdrive). Redis → Railway managed Redis. Neon and
  Upstash-as-primary are retired.
- Object storage → Cloudflare R2 (S3-compatible).
- Secrets/KMS → local AES-256-GCM with `SECRETS_MASTER_KEY`; the deprecated
  AWS KMS provider remains only for callers that already provisioned a key.

## What lives here today

- `gcp/` — partial GKE / foundation modules, not currently wired to CI. Keep
  for future GCP experimentation.
- `hetzner/` — active control-plane, shared-app, and data-plane roots.
- `cloudflare/pages-domains/` — active environment-scoped Pages custom-domain,
  DNS, and certificate bindings for the console and app projects.

Wrangler still owns Cloudflare Worker routes and Pages deployments; the
Cloudflare Terraform root owns only the stable public edge bindings.
