###############################################################################
# Eliza Cloud Apps (Product 2) — SHARED data-plane resources (Hetzner)
#
# This module owns the resources that are shared across staging + production
# app nodes:
#   - the PRIVATE network + subnet (10.30.0.0/16 — no overlap with agents);
#   - the TENANT POSTGRES node (thousands of DATABASE+ROLE, REVOKE CONNECT per
#     tenant) reachable ONLY on the private net — never public;
#   - admin DSN for the tenant DB.
#
# Per-env app worker nodes (and their wildcard DNS record) live in the
# apps-data-plane module, which reads this module's outputs via a
# `terraform_remote_state` data source.
#
# Why split? The tenant DB + private net are physically a single shared piece
# of infra in the apps Hetzner project — one network, one Postgres node holds
# both staging and production tenant DBs (alpha scale). Keeping them in their
# own state file means:
#   - staging vs prod apply rounds can't accidentally rebuild the tenant DB;
#   - app-node-only changes don't touch the shared backend.
#
# The Hetzner server name is intentionally "eliza-app-tenant" (no env suffix)
# because the resource is shared — there is one tenant DB, not two.
###############################################################################

locals {
  common_labels = {
    "managed-by" = "eliza-cloud"
    "tier"       = "apps-shared"
  }
}

# Admin password for the tenant Postgres superuser. Stored in TF state (R2,
# access-controlled). Stable across boots, so the cloud-init ALTER USER is
# idempotent.
resource "random_password" "tenant_db_admin" {
  length  = 40
  special = false # keep DSN URL-safe (no escaping in admin_dsn output)
}

# Operator/daemon SSH access is provisioned by cloud-init: each node's `deploy`
# user gets `var.ssh_public_keys` in its authorized_keys (see cloud-init/*.tftpl).
# We do NOT register an `hcloud_ssh_key` here: the apps Hetzner project is
# shared, and registering the key out-of-band via Hetzner Console keeps both
# this module + apps-data-plane from racing on the same `eliza-op-*` key.

# ── Private network: apps + tenant DB only; isolated from the agent plane ─────
resource "hcloud_network" "apps" {
  name     = "eliza-apps"
  ip_range = var.network_cidr
  labels   = local.common_labels

  # Same convention as the rest of the shared module: ignore Hetzner-side
  # renames so the legacy `eliza-apps-staging` left over from the pre-shared
  # layout doesn't show as a diff. Operators can rename via Console (cosmetic).
  lifecycle {
    ignore_changes = [name]
  }
}

resource "hcloud_network_subnet" "apps" {
  network_id   = hcloud_network.apps.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = var.subnet_cidr
}

# ── Block storage for all tenant databases (PGDATA) ───────────────────────────
resource "hcloud_volume" "tenant_db_data" {
  name      = "eliza-app-tenant-data"
  size      = var.tenant_db_volume_size_gb
  location  = var.hcloud_location
  format    = "ext4"
  labels    = local.common_labels
  automount = false

  # Volume rename via Hetzner Console is operator-cosmetic; the state-mv migration
  # from the per-env apps-data-plane leaves the legacy `eliza-apps-tenantdb-staging`
  # name on the Hetzner side, which a `terraform plan` would otherwise want to
  # in-place rename. Ignoring keeps the post-migration plan a true no-op so the
  # operator's verification gate ("plan should be clean") is honest.
  lifecycle {
    ignore_changes = [name]
  }
}

# ── Firewalls ─────────────────────────────────────────────────────────────────
# Tenant DB node: NO public Postgres. SSH from operators only; Postgres (5432)
# is reachable solely on the private network (no firewall rule opens it publicly).
resource "hcloud_firewall" "tenant_db" {
  name   = "eliza-app-tenant"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.operator_ingress_cidrs
  }

  # Same reason as hcloud_volume.tenant_db_data — the post-migration plan stays
  # clean instead of showing a cosmetic rename that has nothing to do with the
  # rule set the operator actually cares about.
  lifecycle {
    ignore_changes = [name]
  }
}

# ── Tenant Postgres node ──────────────────────────────────────────────────────
# Name is intentionally bare `eliza-app-tenant` — no env suffix — because this
# server is shared across staging + production. lifecycle.ignore_changes
# includes `name` so Hetzner-side renames (e.g. legacy `eliza-apps-tenantdb-
# staging` left over from the pre-shared layout) don't cause drift; operators
# can rename via the Hetzner Console at their discretion (cosmetic only).
resource "hcloud_server" "tenant_db" {
  name         = "eliza-app-tenant"
  location     = var.hcloud_location
  server_type  = var.tenant_db_server_type
  image        = var.hcloud_image
  firewall_ids = [hcloud_firewall.tenant_db.id]
  labels       = merge(local.common_labels, { "role" = "tenant-db" })

  user_data = templatefile("${path.module}/cloud-init/tenant-db.yaml.tftpl", {
    hostname          = "eliza-app-tenant"
    admin_password    = random_password.tenant_db_admin.result
    operator_ssh_keys = var.ssh_public_keys
  })

  # Same convention as control-plane / apps-data-plane: allow in-place rename
  # via Hetzner Console without TF drift; user_data + image swaps re-apply only
  # on `terraform apply -replace=hcloud_server.tenant_db`.
  lifecycle {
    ignore_changes = [user_data, image, name, ssh_keys]
  }
}

resource "hcloud_server_network" "tenant_db" {
  server_id  = hcloud_server.tenant_db.id
  network_id = hcloud_network.apps.id
  # First usable host in the subnet — stable private IP the app nodes + the
  # control-plane provisioner connect to (admin DSN host).
  ip = cidrhost(var.subnet_cidr, 10)
}

resource "hcloud_volume_attachment" "tenant_db_data" {
  volume_id = hcloud_volume.tenant_db_data.id
  server_id = hcloud_server.tenant_db.id
  automount = false
}
