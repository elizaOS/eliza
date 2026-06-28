# Eliza Cloud Apps - shared infra (Hetzner)

The **shared** half of the Apps (Product 2) data plane. Owns the resources
that are physically a single piece of infrastructure across staging + production
app worker nodes:

| Resource | Purpose |
|---|---|
| `hcloud_network.apps` (+ subnet) | Private network for apps + their tenant DB. **No overlap with the agent net.** |
| `hcloud_server.tenant_db` (+ volume) | One self-managed Postgres holding thousands of per-tenant `DATABASE`+`ROLE` (`REVOKE CONNECT FROM PUBLIC` per tenant). Reachable **only** on the private net. |
| `hcloud_firewall.tenant_db` | SSH from operators only — Postgres stays private-net only. |
| `random_password.tenant_db_admin` | The tenant DB superuser password, used to build the admin DSN output. |
| `random_password.pgbouncer_auth` | The pgbouncer `auth_user` credential (resolves per-tenant SCRAM via `auth_query`). |

Per-env app worker nodes + the `*.<apps_base_domain>` Cloudflare record live in
the sibling [`apps-data-plane`](../apps-data-plane/) module, which consumes
this module's outputs through a `terraform_remote_state` data source.

## Launch role

This module is the shared dependency for both staging and production app
workers. It must exist before `apps-data-plane` can be applied in either
environment, and its sensitive `tenant_db_admin_dsn` is what the apps daemon
uses to create per-tenant roles and databases.

**Why:** isolated app DB mode is only real when every deployed app receives a
tenant-specific DSN created from this shared cluster. Without this state, the
Worker can accept deploy requests but the daemon cannot provision isolated
database access.

## State

Single shared backend file (`backend.hcl`) — there is no staging vs production
copy of these resources, only one. Both env apply rounds of `apps-data-plane`
read the same `hetzner/apps-shared/shared.tfstate`.

## Apply

```bash
cd packages/cloud/infra/cloud/terraform/hetzner/apps-shared
cp tfvars/shared.tfvars.example shared.tfvars   # fill in real values
export HCLOUD_TOKEN=...      # the HCLOUD_APPS_TOKEN value
export AWS_ACCESS_KEY_ID=... # R2 token for the tf state backend
export AWS_SECRET_ACCESS_KEY=...
terraform init -backend-config=backend.hcl
terraform plan  -var-file=shared.tfvars
terraform apply -var-file=shared.tfvars
```

Or from CI:

```bash
gh workflow run terraform-apps-shared.yml --ref develop -f action=plan
gh workflow run terraform-apps-shared.yml --ref develop -f action=apply
```

## After apply

1. Encrypt `tenant_db_admin_dsn` and seed it into `tenant_db_clusters`
   (`provider='direct_pg'`, `host=tenant_db_private_ip`). The runtime
   `ClusterPool` allocates from it; the daemon's `DirectPgExecutor` runs
   the per-tenant `CREATE ROLE/DATABASE/REVOKE CONNECT`.
2. Run the `apps-data-plane` apply (staging then production) so app worker
   nodes attach to the shared network published here.

## Connection pooling (pgbouncer) — #8321 P0 #2

The default Postgres ceiling (100 connections) exhausts at ~5 apps under load.
The tenant-db cloud-init now (a) raises `max_connections` to 500 + sizes
`shared_buffers` to ~25% of the node's RAM, and (b) runs **pgbouncer in SESSION
`pool_mode` on `:6432`** in front of Postgres, so app sessions are multiplexed
onto a bounded set of server backends.

**Why session mode (not transaction):** plugin-sql's runtime migrator takes
**session-scoped** advisory locks (`pg_advisory_lock`, not the `_xact_`
variants) across independent pool checkouts. Transaction pooling would acquire
the lock on one backend and release it on another, orphaning it and wedging
migrations. Session mode is the safe drop-in; a future transaction-mode move
would first require reworking that lock path.

The pooler authenticates per-tenant roles via `auth_query` against a
`SECURITY DEFINER` lookup (`public.pgbouncer_user_lookup`) owned by `postgres`
and execute-granted only to the `pgbouncer` role — so the pooler resolves SCRAM
secrets without being a superuser. The app's `REVOKE CONNECT` isolation still
gates every connection.

### Operator rollout (the pooler is INERT until you do step 2)

1. **Roll the tenant-db node** so the new cloud-init runs (installs + configures
   pgbouncer). `user_data` is under `lifecycle.ignore_changes`, so editing the
   template alone does nothing — taint and replace:
   ```bash
   terraform apply -var-file=shared.tfvars -replace=hcloud_server.tenant_db
   ```
   The data volume (PGDATA) survives the replace; it's a disruptive restart.
   (Currently gated on the staging Hetzner server limit — see #8318.)
2. **Route apps through the pooler:** set the `tenant_db_clusters.host` column
   (the **app-facing** per-tenant DSN host) to the `tenant_db_pooler_endpoint`
   output (`10.30.1.10:6432`). New per-tenant DSNs then point at the pooler;
   the **admin/DDL** DSN (`tenant_db_admin_dsn`) stays on `:5432` — role/database
   DDL must not go through the pooler. The DB ambassador forwards whatever port
   the DSN carries, so no app-side change is needed.
3. **Validate:** `psql "<a tenant DSN with :6432>"` connects; `SHOW POOLS;` on
   the pgbouncer admin console shows session pools; `journalctl -u pgbouncer`.

## Outputs

- `apps_network_id` — for `hcloud_server_network` in apps-data-plane.
- `apps_subnet_id` — informational.
- `apps_subnet_cidr` — apps-data-plane uses this to compute app node private IPs.
- `tenant_db_private_ip` — `10.30.1.10`, stable.
- `tenant_db_public_ip` — SSH/admin only.
- `tenant_db_admin_dsn` — **sensitive**; seed into `tenant_db_clusters` (`:5432`, direct).
- `tenant_db_pooler_endpoint` — `10.30.1.10:6432`; set as `tenant_db_clusters.host` to route apps through pgbouncer (after rolling the node).
