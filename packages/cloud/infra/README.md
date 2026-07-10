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

See `cloud/RAILWAY.md` for the canonical service map. Short version:

- `cloud-frontend` → Cloudflare Pages
- `cloud-api` → Cloudflare Worker
- `headscale` → Hetzner control-plane VM (agent path); `tunnel-proxy` → Railway (customer-tunnel path)
- `agent-server` (per-customer compute) → Hetzner via `container-control-plane`
- Database → Neon (Postgres) — ONE shared DB per env (prod `ep-wild-smoke`,
  staging `ep-wild-dawn`); Steward lives as an embedded `steward` schema inside
  that same shared DB, not a separate DB. Per-agent Neon branches are legacy/retired.
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

Manages the persistent control-plane VM(s) that host the elizaOS Cloud provisioning worker, agent router, headscale, and cloudflared. The elastic data-plane sandbox cores are provisioned at runtime by `node-autoscaler.ts`, not by this Terraform.

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
- AWS resources are being retired; see `cloud/AWS_RETIREMENT.md` for the migration plan.
- Production secrets are supplied via external-secrets-operator; the `.env.example` files are for local dev only.
