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
   pgbouncer). `user_data` is under `lifecycle.ignore_changes`, and
   `lifecycle.prevent_destroy` deliberately blocks `terraform taint` or
   `-replace` from destroying the server. Use a separately reviewed maintenance
   change that temporarily removes only the server guard, keeps the PGDATA
   volume and network guarded, and proves in its exact plan that only the
   intended VM is replaced. The replacement is a disruptive restart; restore
   the server guard immediately afterward. (Currently gated on the staging
   Hetzner server limit — see #8318.)
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
- `tenant_db_backup_configured` — `true` only when the off-host encrypted backup pipeline (#21729) is fully armed; `false` means host snapshots are the only safeguard.

## Off-host encrypted recovery — #21729

### Authority and data classification

This module's tenant Postgres node is the single authority for every deployed
app's tenant database (per-tenant `DATABASE`+`ROLE`, `REVOKE CONNECT FROM
PUBLIC`). The data is customer-owned application data — treat it as
confidential. This README, the terraform files, and all job logs must never
carry credentials, DSN values, host secrets, or tenant identifiers; tenant
database names exist only inside the encrypted archive (`dbmap.tsv`), and the
nightly job logs counts/bytes/durations only.

### Recovery objectives

- **RPO: 26 hours** (one nightly backup at 02:15 UTC plus randomized delay and
  slack). Anything written after the last nightly set is lost in a full-node
  loss — an explicitly accepted alpha-scale bound.
- **RTO: 60 minutes** for a rebuild-from-backup onto a fresh isolated node at
  current data volume, measured by the drill harness (below). Re-baseline the
  target as tenant data grows.
- **HA posture:** the node is deliberately single-instance (accepted bounded
  risk at alpha scale). The tested compensations are the protected PGDATA
  volume (survives server rebuilds), Hetzner host snapshots, and the off-host
  encrypted sets with drilled restore timing. Streaming replication/failover
  is a follow-up that must not be improvised during an incident.

### Backup pipeline (armed by terraform variables)

Set `backup_s3_endpoint`, `backup_s3_bucket`, `backup_s3_prefix`,
`backup_s3_access_key`, `backup_s3_secret_key`,
`backup_encryption_passphrase`, and `backup_retention_days` together (a
partial set fails the plan). The bucket must live outside the Hetzner apps
project (e.g. a dedicated R2 bucket) and must never be the terraform state
bucket. Encryption ownership: the archive is AES-256 (PBKDF2) encrypted **on
the node before upload**, so the bucket operator never holds tenant plaintext;
the passphrase lives in the org password manager (cloud-ops vault) and is a
hard dependency for every restore — losing it loses every off-host backup.

Each nightly set under `<prefix>/<UTC stamp>/` holds:

- `backup.tar.gz.enc` — encrypted tar of `pg_dumpall --globals-only`, one
  `pg_dump -Fc` per non-template database (keyed by truncated name hash),
  `dbmap.tsv`, `manifest.json`, and `checksums.sha256`.
- `backup.json` — plaintext sidecar (archive sha256, byte size, database
  count, cipher, timestamp) so freshness/integrity alerting and drills can
  verify the set without the passphrase.

Retention pruning runs in the same job. Because `user_data` is under
`lifecycle.ignore_changes`, the existing node picks up the pipeline via the
guarded replacement procedure above (or by applying the rendered cloud-init
sections by hand during a maintenance window).

### Restore drills (recurring)

Run at least monthly, and after any Postgres/pgbouncer config change:

1. Download the newest set from the bucket to an operator machine or a
   throwaway VM with an **isolated** Postgres instance (never the live node).
2. Initialize a disposable Postgres target with a unique bootstrap superuser
   that does not exist in the source archive (for example
   `eliza_restore_admin_<uuid>`), plus pgbouncer. A default target containing
   the source `postgres` role is intentionally refused before destructive SQL:
   strict `pg_dumpall --globals-only` replay cannot safely ignore role
   collisions. Generate a one-use identity (`drill-<uuid>`) and set it on the
   Postgres server:

   ```sql
   ALTER SYSTEM SET eliza.restore_target_id =
     'drill-11111111-2222-4333-8444-555555555555';
   SELECT pg_reload_conf();
   ```

   The harness inventories existing target roles before restore and refuses
   any collision with `globals.sql`. It also verifies the server-side identity
   in the same psql session before globals, each database drop/create, and each
   database's rendered pg_restore SQL. Restore sessions use `--no-psqlrc`, and
   the harness renders without pg_restore `--create`, so no unguarded reconnect
   exists. A DNS alias, alternate address, or SSH tunnel cannot redirect a
   later destructive connection to another server. Never reuse an identity;
   destroy the target after the drill.

3. Prepare a root-readable `tenant-probes.json` that covers every opaque dump
   id in `dbmap.tsv` and references password environment variables rather
   than containing passwords or database names:

   ```json
   {
     "schema_version": 1,
     "tenants": [
       {
         "dump_id": "0123456789ab",
         "role": "restored_tenant_role",
         "password_env": "DRILL_TENANT_1_PASSWORD"
       }
     ]
   }
   ```

   Export each referenced variable from the protected operator secret source.
   The restored SCRAM hashes authenticate those real roles; values are passed
   to libpq only through `PGPASSWORD` and never enter arguments or reports.

4. Run the harness:

   ```bash
   bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts \
     --set-dir <downloaded-set> \
     --target-dsn postgresql://eliza_restore_admin:...@127.0.0.1:5433/postgres \
     --target-id drill-11111111-2222-4333-8444-555555555555 \
     --pooler-endpoint 127.0.0.1:6432 \
     --tenant-probes-file <path> --passphrase-file <path> \
     --rpo-hours 26 --rto-minutes 60 --output drill-report.json
   ```

   It fails the globals restore on the first SQL error, restores each database,
   then authenticates every tenant role to its own database through both direct
   Postgres and pgbouncer and requires every cross-tenant connection to fail.
   Each successful own connection must also return the one-use target identity.
   The report contains only opaque dump ids/counts and measured RPO/RTO; the
   process exits `2` when objectives are missed.
5. File the redacted `drill-report.json` with the ops evidence for the run and
   destroy the verification instance (the harness already shreds its decrypted
   workspace).

### Staging isolation and production cutover (dual-readiness)

Provisioning a physically separate staging tenant DB precedes any production
authority change: bring up a second node from this module's cloud-init in a
staging-scoped state root, point staging `tenant_db_clusters` rows at it, and
prove a full drill against it. Production cutover then requires reviewed plan
artifacts from the protected `Infrastructure` workflow, both databases passing
the drill (dual readiness), an authority switch done via the
`tenant_db_clusters` rows (reversible by pointing the rows back), and no
credential values in any log or plan output. Post-cutover rollback keeps the
old node intact and guarded until a verified off-host restore of the new
authority exists.

## Persistent-resource safeguards and rollback

The shared tenant Postgres VM has Hetzner backups plus delete and rebuild
protection. Its attached PGDATA volume and private network have delete
protection. Provider backups are a short-term host safeguard only: they do not
provide application-consistent Postgres recovery, point-in-time recovery, or
environment isolation. Those require a separate reviewed design and recurring
restore proof.

The server, volume, and network also use Terraform
`lifecycle.prevent_destroy`. Hetzner's provider removes API delete protection
when Terraform intentionally destroys a resource, so provider protection alone
does not block an accidental replacement from an apply. Removing a resource
block also removes the lifecycle guard and requires a separately reviewed
retirement plan.

Before any apply, run the protected `Infrastructure` workflow with
`component=apps-shared`, `environment=production`, and `operation=plan`, then
review the exact bound plan artifact. Adoption should be in-place. Any server,
volume, or network replacement is a stop condition.

Rollback must preserve the data dependency order: keep volume and network
lifecycle guards and delete protection enabled while the database uses them;
remove the server lifecycle guard or rebuild protection only for an explicitly
reviewed replacement; and remove volume or network guards only in a later
retirement plan after a verified off-host restore. Never detach or destroy the
volume as a shortcut for rolling back backup billing.
