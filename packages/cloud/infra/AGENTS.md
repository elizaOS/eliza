# @elizaos/cloud-infra

Infrastructure-as-code and local-dev tooling for the elizaOS Cloud stack: Kubernetes manifests, Helm values, Terraform, Docker Compose, and shell scripts. This is a private, non-published package (no exports, no `src/`). It is consumed by operators and CI, not by other packages at build time.

## Purpose

`cloud-infra` owns two classes of artifacts:

1. **Local dev cluster** — everything needed to spin up a `kind` Kubernetes cluster that mirrors the cloud services on a developer workstation (`cloud/local/`).
2. **Production Terraform** — Hetzner Cloud control-plane VMs (`cloud/terraform/hetzner/control-plane/`), Hetzner apps-data-plane and apps-shared roots, and experimental GCP roots (`cloud/terraform/gcp/`).

Nothing in this package is imported by TypeScript code. The YAML/Terraform/shell files are consumed directly by `kubectl`, `helm`, `terraform`, `docker compose`, and the chainsaw integration-test runner.

## Layout

```
packages/cloud/infra/
  cloud/
    .env.example                   # Local-dev secrets template; copy to .env
    docker-compose.yml             # Self-hosted Supabase Storage (Postgres + storage-api)
    AWS_RETIREMENT.md              # AWS → Hetzner/Railway migration record (completed; open: KMS sunset + stale gateway role-ARN GitHub env vars)
    RAILWAY.md                     # Canonical service/runtime/request-path map — where each surface runs
    bitrouter/                     # RETIRED — only CLOUDFLARE_MIGRATION_PLAN.md remains (the Worker is the model gateway now)
    charts/
      README.md                    # Charts overview (local/shared charts only; the gateway-discord chart was deleted with the EKS retirement)
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
          import.tf                # Terraform import blocks for existing resources
          backend-staging.hcl      # Cloudflare R2 remote state (staging)
          backend-production.hcl   # Cloudflare R2 remote state (production)
          tfvars/
            staging.tfvars.example
            production.tfvars.example
          cloud-init/
            bootstrap.yaml.tftpl   # cloud-init template: installs Docker, sets up systemd units
        apps-data-plane/           # Hetzner data-plane app servers Terraform root
          main.tf
          outputs.tf
          backend-staging.hcl
          backend-production.hcl
          cloud-init/
        apps-shared/               # Hetzner shared-apps Terraform root
          main.tf
          outputs.tf
          providers.tf
          backend.hcl
          cloud-init/
      cloudflare/
        pages-domains/             # Active: Pages custom-domain + DNS/certificate bindings
      gcp/
        01-foundation/             # GCP foundation (VPC, IAM, GKE module) — experimental, not CI-wired
        02-k8s/                    # GKE cluster resources — experimental, not CI-wired
    tests/                         # Chainsaw operator E2E suites (require a running kind cluster)
      .chainsaw.yaml               # Chainsaw Configuration (name eliza-operator-tests; timeouts, parallelism)
      README.md                    # Per-suite coverage map for the Server operator + agent-server
      0*-<name>/                   # Numbered suites (Server CR input + chainsaw-test.yaml + asserts)
  tests/                           # Top-level Bun smoke tests (YAML-parse only, no cluster needed)
    local-values.test.ts           # Validates CNPG + Redis Helm values YAML structure
    local-manifests.test.ts        # Validates K8s manifests (apiVersion/kind/metadata)
    chainsaw-config.test.ts        # Validates cloud/tests/.chainsaw.yaml shape (kind/timeouts/parallelism)
    chainsaw-suites.test.ts        # Static checks for Chainsaw suites (YAML well-formed, local file refs valid)
    docker-compose.test.ts         # Static coverage for local docker-compose.yml (env placeholders, service shape)
    terraform-static.test.ts       # Lightweight Terraform file invariants (no provider init required)
```

## Key subsystems

### Local dev cluster (`cloud/local/`)

`setup.sh` brings up a `kind` cluster with namespaces `eliza-agents` and `eliza-infra`, applies the manifests (redis alias, redis-rest REST adapter, external-service aliases), then Helm-installs KEDA, metrics-server, the CloudNativePG operator + a CNPG Postgres cluster, and Bitnami Redis using the values files in this directory. It also builds the Pepr Server operator (from `cloud/services/operator`) and the `agent-server` image, then applies the `shared-*.yaml` Server CRs.

The `shared-eliza.yaml` manifest is a `eliza.ai/v1alpha1` Server custom resource — it requires the Pepr operator (which `setup.sh` deploys) to be reconciled.

### Docker Compose (`cloud/docker-compose.yml`)

Self-hosted Supabase Storage (postgres:18-alpine + supabase/storage-api:v1.58.4) providing an S3-compatible API at `localhost:54321/storage/v1/s3`. Use this to run object-storage paths offline without a real Cloudflare R2 bucket. Requires secrets from `.env` (copy from `.env.example`).

### BitRouter Railway service — RETIRED

The Railway BitRouter model-router was removed. The Cloudflare Worker (`cloud-api`) is now the model gateway: it calls native providers directly (Cerebras/OpenAI/Anthropic/Groq/Vast) and uses OpenRouter (BYOK, `OPENROUTER_API_KEY`) as the backup for models with no native key. Only `cloud/bitrouter/CLOUDFLARE_MIGRATION_PLAN.md` remains as the record. Operator: stop/delete the Railway `bitrouter` service.

### Hetzner Terraform (`cloud/terraform/hetzner/`)

Three Terraform roots:
- **`control-plane/`** — manages the control-plane VMs only (one per env: `eliza-staging-1`, `eliza-production-1`).
- **`apps-data-plane/`** — manages Hetzner data-plane app server resources.
- **`apps-shared/`** — manages shared Hetzner infrastructure.

The separate **`cloudflare/pages-domains/`** root adopts and manages the
environment-specific Pages custom domains and CNAMEs for `eliza-cloud` and
`eliza-app`. Wrangler continues to own deployments and Worker routes; this root
prevents dashboard-only domain/certificate drift.

The **data plane** is not in Terraform: dedicated robot nodes (`eliza-core-{env}-N`) are registered in the `docker_nodes` table (authoritative; `CONTAINERS_DOCKER_NODES` env only seeds when empty) and extra burst capacity (`eliza-core-<hex>`) is minted at runtime by `packages/cloud/shared/src/lib/services/containers/node-autoscaler.ts` via the Hetzner Cloud API.

Each control-plane VM runs:
- `eliza-provisioning-worker` — job queue consumer (systemd unit, deployed by CI)
- `eliza-agent-router` — subdomain HTTP routing (systemd unit)
- `headscale` — VPN mesh for agent traffic
- `nginx` — public ingress: the agent-router vhost (self-signed wildcard cert
  behind Cloudflare-proxied DNS, zone SSL mode "Full") and the headscale vhost
  (Let's Encrypt, DNS-only record). `cloudflared` is not in the request path.

Remote state lives in Cloudflare R2 bucket `eliza-terraform-state`. Use `backend-staging.hcl` or `backend-production.hcl` for `terraform init -backend-config=`.

### Chainsaw operator E2E (`cloud/tests/`)

Numbered [Chainsaw](https://kyverno.github.io/chainsaw/) suites (`cloud/tests/0*/`) that exercise the Pepr Server operator against a running kind cluster: they apply Server CRs and assert the generated Deployment / Service / KEDA ScaledObject plus the agent-server HTTP lifecycle. Driven by `cloud/tests/.chainsaw.yaml` (`chainsaw test --config .chainsaw.yaml`). The top-level `tests/chainsaw-config.test.ts` only validates that config's shape; running the suites themselves needs `chainsaw` plus the cluster from `setup.sh`.

## Commands

```bash
bun run --cwd packages/cloud/infra test       # Run YAML/manifest smoke tests (Bun test)
```

Local cluster scripts (run directly, not via bun):
```bash
bash packages/cloud/infra/cloud/local/setup.sh       # Bootstrap kind cluster
bash packages/cloud/infra/cloud/local/teardown.sh    # Destroy kind cluster
bash packages/cloud/infra/cloud/local/smoke-test.sh  # Liveness checks
docker compose --project-directory packages/cloud/infra/cloud up -d storage  # Start local S3
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
- **AWS is retired** (open: the KMS sunset and deleting the stale gateway role-ARN vars from the GitHub environments). See `cloud/AWS_RETIREMENT.md`. Do not add new AWS dependencies.
- **Data-plane cores are not in Terraform.** Dedicated robot nodes (`eliza-core-{env}-N`, OS host `eliza-{env}-robot-N`) live in the `docker_nodes` table (authoritative; `CONTAINERS_DOCKER_NODES` env only seeds when empty); autoscaled burst nodes (`eliza-core-<hex>`) are runtime-provisioned by `node-autoscaler.ts`. Only the control-plane VM is managed here.
- **Remote state uses Cloudflare R2**, not an S3 bucket — export the R2 token as `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` before `terraform init`.
- **Production secrets are not in docker-compose.** The compose file only serves local dev. Real secrets live where each runtime reads them: `wrangler secret put` for the Worker (published on deploy by `cloud-cf-deploy.yml`), the `staging`/`production` GitHub Environments for deploy workflows, per-service Railway env vars (see each `railway.toml` header), and `/opt/eliza/cloud/.env.local` on the control-plane VM. Nothing production runs on Kubernetes, so there is no cluster secret store.
- **`cloud/local/setup.sh` installs the `vector` and `uuid-ossp` Postgres extensions** via `postInitApplicationSQL` in `values-pg-local.yaml` — these are required by `packages/app-core`.
- **`user_data` and `image` changes do not recreate the Hetzner VM** — `lifecycle { ignore_changes }` is set in `main.tf`. To rebuild with a new image, use `terraform taint`.
- **Tests in `tests/` are pure YAML-parse smoke tests** — they do not require a running cluster or any cloud credentials.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
