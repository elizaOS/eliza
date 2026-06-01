# @elizaos/cloud-infra

Infrastructure-as-code and local-dev tooling for the elizaOS Cloud stack: Kubernetes manifests, Helm values, Terraform, Docker Compose, and shell scripts. This is a private, non-published package (no exports, no `src/`). It is consumed by operators and CI, not by other packages at build time.

## Purpose

`cloud-infra` owns two classes of artifacts:

1. **Local dev cluster** — everything needed to spin up a `kind` Kubernetes cluster that mirrors the cloud services on a developer workstation (`cloud/local/`).
2. **Production Terraform** — Hetzner Cloud control-plane VMs (`cloud/terraform/hetzner/control-plane/`) and experimental GCP roots (`cloud/terraform/gcp/`).

Nothing in this package is imported by TypeScript code. The YAML/Terraform/shell files are consumed directly by `kubectl`, `helm`, `terraform`, `docker compose`, and the chainsaw integration-test runner.

## Layout

```
packages/cloud-infra/
  cloud/
    .env.example                   # Local-dev secrets template; copy to .env
    docker-compose.yml             # Self-hosted Supabase Storage (Postgres + storage-api)
    AWS_RETIREMENT.md              # AWS → Railway/Hetzner migration status
    RAILWAY.md                     # Canonical map of where each service runs
    charts/
      README.md                    # Charts overview (gateway-discord chart is service-local)
    local/                         # kind cluster setup for local development
      kind-config.yaml             # 1 control-plane + 1 worker node definition
      setup.sh                     # Bootstraps the full local kind cluster
      teardown.sh                  # Tears down the local kind cluster
      smoke-test.sh                # Basic liveness checks against the local cluster
      ngrok-webhook.sh             # Exposes gateway-webhook locally via ngrok
      values-pg-local.yaml         # CNPG (CloudNativePG) Helm values (Postgres 17 standalone)
      values-redis-local.yaml      # Bitnami Redis chart values (standalone, no auth)
      .env.agents.example          # agent-server env vars for local cluster
      .env.gateway.example         # gateway-discord env vars for local cluster
      .env.gateway-webhook.example # gateway-webhook env vars for local cluster
      manifests/
        namespaces.yaml            # eliza-agents + eliza-infra namespaces
        external-services.yaml     # ExternalName Services: redis, eliza-cloud
        redis-rest.yaml            # Upstash-compatible REST adapter (Deployment + Service)
        shared-eliza.yaml          # eliza.ai/v1alpha1 Server CR for local shared agent
    terraform/
      README.md                    # Terraform status (GCP partial; Hetzner active)
      hetzner/
        ARCHITECTURE.md            # Two-tier design: control plane vs data plane
        control-plane/             # Active: Hetzner control-plane VM Terraform root
          main.tf                  # hcloud_server + SSH keys + Cloudflare DNS records
          variables.tf             # environment, server type, SSH keys, zone ID, count
          outputs.tf               # VM IPs, DNS names
          providers.tf             # hcloud + cloudflare providers
          versions.tf              # Terraform + provider version constraints
          backend-staging.hcl      # Cloudflare R2 remote state (staging)
          backend-production.hcl   # Cloudflare R2 remote state (production)
          tfvars/
            staging.tfvars.example
            production.tfvars.example
          cloud-init/
            bootstrap.yaml.tftpl   # cloud-init template: installs Docker, sets up systemd units
      gcp/
        01-foundation/             # GCP foundation (VPC, IAM) — experimental, not CI-wired
        02-k8s/                    # GKE cluster — experimental, not CI-wired
  tests/
    local-values.test.ts           # Validates CNPG + Redis Helm values YAML structure
    local-manifests.test.ts        # Validates K8s manifests (apiVersion/kind/metadata)
    chainsaw-config.test.ts        # Validates .chainsaw.yaml for cluster integration tests
```

## Key subsystems

### Local dev cluster (`cloud/local/`)

Brings up a `kind` cluster with namespaces `eliza-agents` and `eliza-infra`, applies manifests (Redis, redis-rest REST adapter, external-service aliases), and installs CNPG + Bitnami Redis via Helm using the values files in this directory.

The `shared-eliza.yaml` manifest is a `eliza.ai/v1alpha1` Server custom resource — it requires the elizaOS operator to be installed in the cluster to be reconciled.

### Docker Compose (`cloud/docker-compose.yml`)

Self-hosted Supabase Storage (postgres:18-alpine + supabase/storage-api:v1.58.4) providing an S3-compatible API at `localhost:54321/storage/v1/s3`. Use this to run object-storage paths offline without a real Cloudflare R2 bucket. Requires secrets from `.env` (copy from `.env.example`).

### Hetzner Terraform (`cloud/terraform/hetzner/control-plane/`)

Manages the **control-plane** VMs only. The **data plane** (sandbox cores named `eliza-core-<hex>`) is provisioned at runtime by `packages/cloud-shared/src/lib/services/containers/node-autoscaler.ts` via the Hetzner Cloud API — not by this Terraform.

The current production control-plane VM runs:
- `eliza-provisioning-worker` — job queue consumer (systemd unit, deployed by CI)
- `eliza-agent-router` — subdomain HTTP routing (systemd unit)
- `headscale` — VPN mesh for agent traffic
- `cloudflared` — public tunnel (`sandboxes.elizacloud.ai`)

Remote state lives in Cloudflare R2 bucket `eliza-terraform-state`. Use `backend-staging.hcl` or `backend-production.hcl` for `terraform init -backend-config=`.

## Commands

```bash
bun run --cwd packages/cloud-infra test       # Run YAML/manifest smoke tests (Bun test)
```

Local cluster scripts (run directly, not via bun):
```bash
bash packages/cloud-infra/cloud/local/setup.sh       # Bootstrap kind cluster
bash packages/cloud-infra/cloud/local/teardown.sh    # Destroy kind cluster
bash packages/cloud-infra/cloud/local/smoke-test.sh  # Liveness checks
docker compose --project-directory packages/cloud-infra/cloud up -d storage  # Start local S3
```

## Config / env vars

Local dev only (copy `.env.example` → `.env` in `cloud/`):
- `STORAGE_DB_USER`, `STORAGE_DB_PASSWORD` — Postgres credentials
- `STORAGE_ANON_KEY`, `STORAGE_SERVICE_KEY` — Supabase Storage JWTs (HS256)
- `STORAGE_AUTH_JWT_SECRET`, `STORAGE_PGRST_JWT_SECRET` — JWT signing secrets (min 32 chars)
- `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` — S3 protocol credentials

Hetzner Terraform (export before `terraform plan/apply`):
- `HCLOUD_TOKEN` — Hetzner Cloud project API token
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token (DNS edit on `elizacloud.ai`)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — Cloudflare R2 token (for Terraform remote state)

Local cluster service env vars (copy from `.env.*.example`):
- `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY` (`.env.agents.example`)
- `ELIZA_CLOUD_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `GATEWAY_BOOTSTRAP_SECRET` (`.env.gateway.example`)
- Telegram / WhatsApp / Twilio / Blooio tokens (`.env.gateway-webhook.example`)

## How to extend

**Add a new K8s manifest for the local cluster:**
1. Drop the YAML file in `cloud/local/manifests/`.
2. Reference it in `cloud/local/setup.sh` (`kubectl apply -f manifests/<new>.yaml`).
3. Add a test block in `tests/local-manifests.test.ts` validating `apiVersion`, `kind`, and `metadata.name`.

**Add a new Helm values file for the local cluster:**
1. Add the YAML file in `cloud/local/` (e.g. `values-<chart>-local.yaml`).
2. Reference it in `setup.sh` (`helm upgrade --install ... -f values-<chart>-local.yaml`).
3. Add a test block in `tests/local-values.test.ts` verifying the required fields for that chart.

**Add a new Terraform variable to the Hetzner control-plane root:**
1. Declare it in `cloud/terraform/hetzner/control-plane/variables.tf`.
2. Update `tfvars/staging.tfvars.example` and `tfvars/production.tfvars.example`.
3. Reference it in `main.tf`.

## Conventions / gotchas

- **GCP Terraform is not active.** `cloud/terraform/gcp/` is experimental and not wired to any CI workflow. Do not assume it represents the live deployment.
- **AWS resources are being retired.** See `cloud/AWS_RETIREMENT.md`. Do not add new AWS dependencies.
- **Data-plane cores are not in Terraform.** The `eliza-core-<hex>` sandbox VMs are runtime-provisioned by `node-autoscaler.ts`. Only the control-plane VM is managed here.
- **Remote state uses Cloudflare R2**, not an S3 bucket — export the R2 token as `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` before `terraform init`.
- **Production secrets are not in docker-compose.** The compose file only serves local dev. Production K8s workloads receive secrets from external-secrets-operator (ESO).
- **`cloud/local/setup.sh` installs the `vector` and `uuid-ossp` Postgres extensions** via `postInitApplicationSQL` in `values-pg-local.yaml` — these are required by `packages/app-core`.
- **`user_data` and `image` changes do not recreate the Hetzner VM** — `lifecycle { ignore_changes }` is set in `main.tf`. To rebuild with a new image, use `terraform taint`.
- **Tests in `tests/` are pure YAML-parse smoke tests** — they do not require a running cluster or any cloud credentials.
