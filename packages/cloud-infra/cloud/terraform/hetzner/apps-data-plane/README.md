# Eliza Cloud Apps — data plane (Hetzner) — **REVIEW DRAFT**

> ⚠️ **Draft for Stan (data-plane owner). NOT applied.** This is the IaC half of
> "Eliza Cloud Apps" (Product 2). The application code is built + verified in
> **PR #8293**; this terraform stands up the isolated infrastructure it targets.
> Review + harden the `STAN:` items before `terraform apply`.

## What this provisions
The **isolated apps data plane**, kept separate from the agent data plane by
design (*agents share the data plane; apps get an isolated one*):

| Resource | Purpose |
|---|---|
| `hcloud_network.apps` (+ subnet) | Private network for apps + their tenant DB. **No overlap with the agent net.** |
| `hcloud_server.tenant_db` (+ volume) | One self-managed Postgres holding thousands of per-tenant `DATABASE`+`ROLE` (`REVOKE CONNECT FROM PUBLIC` per tenant). Reachable **only** on the private net. |
| `hcloud_server.app_node[*]` | Docker host(s) for **untrusted** user containers (per-app `--internal` net + cap-drop + egress proxy). |
| `hcloud_firewall.*` | App node: SSH + 80/443. Tenant DB: SSH only (Postgres private-net only). |
| `cloudflare_dns_record.apps_wildcard` | `*.<apps_base_domain>` → app node (use an LB for >1 node). |

## How it connects to the code (PR #8293)
1. `terraform apply` →` outputs.tenant_db_admin_dsn` (sensitive) + `app_node_ips`.
2. Encrypt the admin DSN, seed it into **`tenant_db_clusters`** (`provider='direct_pg'`,
   `host=tenant_db_private_host`). The runtime `ClusterPool` allocates from it; the
   daemon's `DirectPgExecutor` runs the per-tenant `CREATE ROLE/DATABASE/REVOKE CONNECT`.
3. Set daemon/Worker env: `CONTAINERS_DOCKER_NODES` (= `app_node_ips`),
   `CONTAINERS_PUBLIC_BASE_DOMAIN` (= `apps_base_domain`), `CONTAINERS_EGRESS_PROXY_URL`,
   the image registry.
4. Wire the 2 gated boot one-liners: cloud-api `configureAppsDeployTrigger()` +
   daemon `configureAppsDeployBackend({ registry, buildExec })`.
5. Flip the feature gate for an allowlist; **on-node kernel re-check** (throwaway
   `--internal` scratch net) before opening to users.

## Apply (after review)

**One-shot setup on a fresh `apps` Hetzner project**, then every subsequent
apply just works:

1. **Generate a Hetzner API token** scoped to the `apps` project (Console →
   Security → API Tokens). Store it as the repo-level GitHub secret
   `HCLOUD_APPS_TOKEN` (shared across staging + production — the apps data
   plane is one project, see `../ARCHITECTURE.md`).
2. **Register the operator SSH public key** in the `apps` project (Console →
   Security → SSH Keys → Add). Without this, the `eliza-op-${env}` key
   isn't usable by the autoscaler's later `--ssh-key` references and recovery
   paths break. cloud-init still seeds `authorized_keys` from
   `var.ssh_public_keys` for the `deploy` user — but the hcloud-managed key
   is the canonical fallback for root-level `hcloud server reset` flows.

Then plan/apply from CI:

```bash
gh workflow run terraform-apps-data-plane.yml --ref develop \
  -f environment=staging -f action=plan
# Review the plan in the run logs, then:
gh workflow run terraform-apps-data-plane.yml --ref develop \
  -f environment=staging -f action=apply
```

Or locally for debugging:

```bash
cd packages/cloud-infra/cloud/terraform/hetzner/apps-data-plane
cp tfvars/staging.tfvars.example staging.tfvars   # fill in real values
export HCLOUD_TOKEN=...      # the HCLOUD_APPS_TOKEN value
terraform init -backend-config=backend-staging.hcl
terraform plan  -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars
```

## STAN — must confirm before production
- **SSH surface:** `operator_ingress_cidrs` is world-open in the draft. Tighten.
- **Untrusted-image hardening:** gVisor (runsc) / Kata / userns-remap + seccomp on
  the app node — the draft uses stock docker + `--cap-drop=ALL` + `--internal`
  (the verified baseline, not defense-in-depth vs a kernel 0-day).
- **Tenant DB:** TLS cert for `hostssl`, backups (volume snapshots), the admin
  password lifecycle (currently a `random_password` in TF state), Postgres tuning
  for thousands of small DBs, and the shard story as `database_count` grows.
- **Ingress/TLS:** install Caddy (or reuse the existing ingress-map → Caddyfile
  emitter) on the app node; front multiple app nodes with `hcloud_load_balancer`.
- **Egress allowlist:** `squid` default-deny currently allows only ghcr.io +
  githubusercontent — extend to what apps legitimately need.
