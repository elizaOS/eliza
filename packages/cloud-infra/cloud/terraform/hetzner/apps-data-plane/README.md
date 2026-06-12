# Eliza Cloud Apps — per-env data plane (Hetzner)

> The IaC half of "Eliza Cloud Apps" (Product 2). The application code is built
> + verified in **PR #8293**; this terraform stands up the per-env worker nodes
> + wildcard DNS. Shared resources (private network + tenant Postgres) live in
> the sibling [`apps-shared`](../apps-shared/) module — apply that one **first**.

## What this provisions

The **per-env** pieces of the apps data plane:

| Resource | Purpose |
|---|---|
| `hcloud_server.app_node[*]` | Docker host(s) for **untrusted** user containers (per-app `--internal` net + cap-drop + egress proxy). |
| `hcloud_server_network.app_node[*]` | Attaches each app node to the SHARED `apps-shared` private network. |
| `hcloud_firewall.app_node` | SSH + 80/443. |
| `cloudflare_dns_record.apps_wildcard` | `*.<apps_base_domain>` → app node (use an LB for >1 node). |

The shared private network, tenant Postgres node, and `random_password` admin
secret live in [`../apps-shared`](../apps-shared/). This module reads them via
a `terraform_remote_state` data source pointed at
`hetzner/apps-shared/shared.tfstate`.

## How it connects to the code (PR #8293)
1. Apply `../apps-shared` once → `outputs.tenant_db_admin_dsn` (sensitive) +
   `tenant_db_private_ip`.
2. Encrypt the admin DSN, seed it into **`tenant_db_clusters`** (`provider='direct_pg'`,
   `host=tenant_db_private_ip`). The runtime `ClusterPool` allocates from it;
   the daemon's `DirectPgExecutor` runs the per-tenant `CREATE ROLE/DATABASE/REVOKE CONNECT`.
3. Apply THIS module per env → `outputs.app_node_ips`.
4. Set daemon/Worker env: `CONTAINERS_DOCKER_NODES` (= `app_node_ips`),
   `CONTAINERS_PUBLIC_BASE_DOMAIN` (= `apps_base_domain`), `CONTAINERS_EGRESS_PROXY_URL`,
   the image registry.
5. Wire the 2 gated boot one-liners: cloud-api `configureAppsDeployTrigger()` +
   daemon `configureAppsDeployBackend({ registry, buildExec })`.
6. Flip the feature gate for an allowlist; **on-node kernel re-check** (throwaway
   `--internal` scratch net) before opening to users.

## Apply (after review)

**One-shot setup on a fresh `apps` Hetzner project**:

1. **Generate a Hetzner API token** scoped to the `apps` project (Console →
   Security → API Tokens). Store it as the repo-level GitHub secret
   `HCLOUD_APPS_TOKEN` (shared across staging + production — the apps data
   plane is one project, see `../ARCHITECTURE.md`).
2. **Register the operator SSH public key** in the `apps` project (Console →
   Security → SSH Keys → Add). cloud-init still seeds `authorized_keys` from
   `var.ssh_public_keys` for the `deploy` user — but the hcloud-managed key
   is the canonical fallback for root-level `hcloud server reset` flows.
3. **Apply `../apps-shared` first** — this module's `terraform_remote_state`
   data source will fail until that state file exists.

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
- **SSH surface:** `operator_ingress_cidrs` — tighten.
- **Untrusted-image hardening:** gVisor (runsc) / Kata / userns-remap + seccomp on
  the app node — the draft uses stock docker + `--cap-drop=ALL` + `--internal`
  (the verified baseline, not defense-in-depth vs a kernel 0-day).
- **Ingress/TLS:** install Caddy (or reuse the existing ingress-map → Caddyfile
  emitter) on the app node; front multiple app nodes with `hcloud_load_balancer`.
- **Egress allowlist:** `squid` default-deny on the app node currently allows only
  ghcr.io + githubusercontent — extend to what apps legitimately need.
