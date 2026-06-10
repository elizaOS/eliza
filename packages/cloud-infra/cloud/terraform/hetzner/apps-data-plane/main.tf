###############################################################################
# Eliza Cloud Apps (Product 2) — data plane (Hetzner)
#
# ⚠️ REVIEW DRAFT for Stan (data-plane owner). NOT yet applied. This stands up
# the ISOLATED apps data plane that the verified cloud-shared code (PR #8293)
# targets — kept SEPARATE from the agent data plane by design:
#   agents share the data plane; apps get an isolated data plane.
#
# Topology:
#   - a PRIVATE network (no overlap with the agent net) that only apps + their
#     tenant Postgres live on;
#   - a TENANT POSTGRES node (thousands of DATABASE+ROLE, REVOKE CONNECT per
#     tenant) reachable ONLY on the private net — never public;
#   - APP WORKER node(s) running untrusted user containers on per-app `--internal`
#     docker networks + a default-deny egress proxy (enforced by the runtime code
#     in cloud-shared, see app-network-utils.ts); the node firewall is a 2nd layer.
#
# SECURITY ITEMS STAN MUST CONFIRM before apply (search "STAN:"):
#   - tighten operator_ingress_cidrs (SSH currently world-open for the draft);
#   - decide gVisor/Kata/userns hardening on the app node for untrusted images;
#   - tenant DB backups (volume snapshots) + the admin password lifecycle;
#   - whether the egress proxy allowlist + Postgres tuning live in cloud-init or
#     a config-management follow-up.
###############################################################################

locals {
  common_labels = {
    "managed-by"  = "eliza-cloud"
    "tier"        = "apps-data-plane"
    "environment" = var.environment
  }
}

# Admin password for the tenant Postgres superuser. Stored in TF state (R2,
# access-controlled). STAN: prefer wiring this to a secret store + rotation; for
# the draft it's generated here so the cluster is self-contained.
resource "random_password" "tenant_db_admin" {
  length  = 40
  special = false # keep DSN URL-safe (no escaping in admin_dsn_encrypted)
}

# Operator/daemon SSH access is provisioned by cloud-init: each node's `deploy`
# user gets `var.ssh_public_keys` in its authorized_keys (see cloud-init/*.tftpl),
# and the provisioning-worker SSHes in as `deploy`. We intentionally do NOT
# register an `hcloud_ssh_key` here: the apps Hetzner project is shared across
# staging + production (Apps Product 2 is alpha — one project for both envs is
# enough). Both env applies would race on the same `eliza-op-...` key and 409
# the second one. The operator pubkey is added to the apps project ONCE via
# Hetzner Console (out-of-band, one-shot); after that all cloud-init writes
# work — they only need the pubkey string in var.ssh_public_keys, not a
# Hetzner-registered key reference.

# ── Private network: apps + tenant DB only; isolated from the agent plane ─────
resource "hcloud_network" "apps" {
  name     = "eliza-apps-${var.environment}"
  ip_range = var.network_cidr
  labels   = local.common_labels
}

resource "hcloud_network_subnet" "apps" {
  network_id   = hcloud_network.apps.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = var.subnet_cidr
}

# ── Block storage for all tenant databases (PGDATA) ───────────────────────────
resource "hcloud_volume" "tenant_db_data" {
  name      = "eliza-apps-tenantdb-${var.environment}"
  size      = var.tenant_db_volume_size_gb
  location  = var.hcloud_location
  format    = "ext4"
  labels    = local.common_labels
  automount = false
}

# ── Firewalls ─────────────────────────────────────────────────────────────────
# App worker node: SSH from operators, public ingress (80/443) for app URLs.
# Container-level egress isolation is enforced in the runtime (per-app --internal
# net + squid default-deny). This node firewall is the coarse second layer.
resource "hcloud_firewall" "app_node" {
  name   = "eliza-apps-node-${var.environment}"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.operator_ingress_cidrs # STAN: tighten before prod
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# Tenant DB node: NO public Postgres. SSH from operators only; Postgress (5432)
# is reachable solely on the private network (no firewall rule opens it publicly).
resource "hcloud_firewall" "tenant_db" {
  name   = "eliza-apps-tenantdb-${var.environment}"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.operator_ingress_cidrs # STAN: tighten before prod
  }
}

# ── Tenant Postgres node ──────────────────────────────────────────────────────
resource "hcloud_server" "tenant_db" {
  name         = "eliza-apps-tenantdb-${var.environment}"
  location     = var.hcloud_location
  server_type  = var.tenant_db_server_type
  image        = var.hcloud_image
  firewall_ids = [hcloud_firewall.tenant_db.id]
  labels       = merge(local.common_labels, { "role" = "tenant-db" })

  user_data = templatefile("${path.module}/cloud-init/tenant-db.yaml.tftpl", {
    hostname          = "eliza-apps-tenantdb-${var.environment}"
    admin_password    = random_password.tenant_db_admin.result
    operator_ssh_keys = var.ssh_public_keys
  })

  # Allow in-place rename via Hetzner Console without TF drift (matches control-plane).
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

# ── App worker node(s) ────────────────────────────────────────────────────────
resource "hcloud_server" "app_node" {
  for_each = toset([for i in range(var.app_node_count) : tostring(i + 1)])

  name         = "eliza-apps-node-${var.environment}-${each.value}"
  location     = var.hcloud_location
  server_type  = var.app_node_server_type
  image        = var.hcloud_image
  firewall_ids = [hcloud_firewall.app_node.id]
  labels = merge(local.common_labels, {
    "role"           = "app-node"
    "app-node-index" = each.value
  })

  user_data = templatefile("${path.module}/cloud-init/app-node.yaml.tftpl", {
    hostname          = "eliza-apps-node-${var.environment}-${each.value}"
    operator_ssh_keys = var.ssh_public_keys
    tenant_db_host    = cidrhost(var.subnet_cidr, 10)
  })

  # Allow in-place rename via Hetzner Console without TF drift (matches control-plane).
  lifecycle {
    ignore_changes = [user_data, image, name, ssh_keys]
  }
}

resource "hcloud_server_network" "app_node" {
  for_each = hcloud_server.app_node

  server_id  = each.value.id
  network_id = hcloud_network.apps.id
  ip         = cidrhost(var.subnet_cidr, 20 + tonumber(each.key))
}

# ── Ingress DNS: wildcard for per-app URLs -> app node (single-node draft) ─────
# STAN: with >1 app node, front this with a load balancer (hcloud_load_balancer)
# and point the wildcard at the LB instead of a single node.
resource "cloudflare_dns_record" "apps_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.apps_base_domain}"
  type    = "A"
  content = hcloud_server.app_node["1"].ipv4_address
  ttl     = 60
  proxied = false
  comment = "eliza apps wildcard ingress (managed by terraform/hetzner/apps-data-plane)"
}
