# @elizaos/cloud-infra

Infrastructure-as-code for the elizaOS Cloud stack. Contains Kubernetes manifests, Helm values files, Terraform roots, Docker Compose, and shell scripts. This package has no TypeScript source and is not published to npm.

## What it contains

| Directory | Purpose |
|---|---|
| `cloud/local/` | kind cluster setup for local development (scripts, Helm values, K8s manifests) |
| `cloud/docker-compose.yml` | Self-hosted Supabase Storage for offline object-storage testing |
| `cloud/terraform/hetzner/control-plane/` | Terraform for the elizaOS Cloud Hetzner control-plane VMs |
| `cloud/terraform/cloudflare/pages-domains/` | Terraform for Pages custom domains, DNS, and certificate bindings |
| `cloud/terraform/gcp/` | Experimental GCP/GKE roots (not active, not CI-wired) |
| `tests/` | Bun smoke tests validating YAML structure (no cluster required) |

## Deployment topology

See `cloud/RAILWAY.md` for the canonical service/runtime/request-path map.
Short version:

- Frontends → Cloudflare Pages: two projects (`eliza-cloud` at the
  `elizacloud.ai` apex, `eliza-app` at `app.elizacloud.ai`), both built from
  `packages/app` (`packages/cloud-frontend` was deleted)
- `eliza-cloud-api` → ONE Cloudflare Worker (`packages/cloud/api`): REST API,
  auth, billing, model gateway, dedicated-agent proxy, and the public batch
  voice routes
- Database → Railway managed Postgres — one env-scoped `DATABASE_URL` per
  environment; the Worker connects through its Hyperdrive binding. Neon is
  retired. Steward auth runs embedded in the Worker at `/steward*`.
- Redis → Railway managed Redis (TCP `REDIS_URL`); Upstash REST is a legacy
  fallback only
- `gateway-discord` / `gateway-webhook` → Railway (Docker manifests in each
  service directory)
- `voice-kokoro-tts` / `voice-whisper-stt` → Railway, private origins behind
  the Worker's `/api/v1/voice/*` routes
- `headscale` → Hetzner control-plane VM (agent path); `tunnel-proxy` → Railway (customer-tunnel path)
- `agent-server` (per-customer compute) → containers on Hetzner data-plane
  nodes, provisioned by the control-plane daemons
- Object storage → Cloudflare R2

## Local development cluster

Brings up a `kind` cluster with Postgres 17 (CloudNativePG), Redis (Bitnami), a redis-rest REST adapter, and an optional shared Eliza agent.

```bash
# 1. Copy and fill secrets
cp cloud/.env.example cloud/.env
$EDITOR cloud/.env

# 2. Start the cluster
bash cloud/local/setup.sh

# 3. Verify
bash cloud/local/smoke-test.sh

# 4. Tear down
bash cloud/local/teardown.sh
```

### Local object storage (Docker Compose)

Runs a local S3-compatible Supabase Storage API on `localhost:54321/storage/v1/s3` backed by Postgres on `localhost:54322`.

```bash
cd cloud
docker compose up -d storage      # start
docker compose down               # stop
docker compose down -v            # stop + wipe volumes
```

## Hetzner control-plane Terraform

Manages the persistent control-plane VM(s) that host the elizaOS Cloud provisioning worker, agent router, headscale, and the nginx ingress. The elastic data-plane sandbox cores are provisioned at runtime by `node-autoscaler.ts`, not by this Terraform.

```bash
cd cloud/terraform/hetzner/control-plane

# Init with Cloudflare R2 remote state
export AWS_ACCESS_KEY_ID=<r2-token>
export AWS_SECRET_ACCESS_KEY=<r2-secret>
terraform init -backend-config=backend-staging.hcl

# Copy and fill tfvars
cp tfvars/staging.tfvars.example tfvars/staging.tfvars
$EDITOR tfvars/staging.tfvars

# Plan and apply
export HCLOUD_TOKEN=<hetzner-token>
export CLOUDFLARE_API_TOKEN=<cf-token>
terraform plan -var-file=tfvars/staging.tfvars
terraform apply -var-file=tfvars/staging.tfvars
```

See `cloud/terraform/hetzner/ARCHITECTURE.md` for the two-tier (control plane / data plane) design rationale and the code-to-infrastructure mapping.

## Tests

YAML structure smoke tests — validate Helm values files and K8s manifests without a running cluster or cloud credentials.

```bash
bun run --cwd packages/cloud/infra test
```

## Notes

- GCP Terraform (`cloud/terraform/gcp/`) is experimental and not wired to CI.
- AWS is retired (open: the KMS sunset and deleting the stale gateway role-ARN
  vars from the GitHub environments); see `cloud/AWS_RETIREMENT.md` for the record.
- Production secrets are not in this package. Each runtime reads its own:
  Worker secrets via `wrangler secret put` (published on deploy by
  `cloud-cf-deploy.yml`), deploy-time secrets in the `staging`/`production`
  GitHub Environments, per-service Railway env vars (see each `railway.toml`
  header), and the control-plane daemon env in `/opt/eliza/cloud/.env.local`.
  The `.env.example` files here are for local dev only.
