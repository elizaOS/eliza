###############################################################################
# Eliza Cloud Apps (Product 2) — per-env data plane (Hetzner)
#
# This module owns the PER-ENV pieces of the apps data plane: the app worker
# node(s) (Docker hosts for untrusted user images) and the Cloudflare wildcard
# record routing per-app URLs at them.
#
# The SHARED pieces (private network, tenant Postgres node) live in
# ../apps-shared and are read here via a `terraform_remote_state` data source.
#
# Topology:
#   - SHARED (one private network, one tenant Postgres node) — owned by
#     ../apps-shared/, single backend, no env suffix on resource names;
#   - PER-ENV (app worker node(s) + wildcard DNS) — this module, one tfstate
#     per env (backend-staging.hcl / backend-production.hcl).
#
# Security items to keep in mind (search "STAN:"):
#   - tighten operator_ingress_cidrs (SSH);
#   - gVisor/Kata/userns hardening on the app node for untrusted images;
#   - egress proxy allowlist for app containers.
###############################################################################

locals {
  common_labels = {
    "managed-by"  = "eliza-cloud"
    "tier"        = "apps-data-plane"
    "environment" = var.environment
  }
}

# ── Shared infra (private network + tenant DB) lives in ../apps-shared ────────
# Read its outputs so app nodes attach to the same network the tenant DB lives
# on. The shared state has a single backend (no env suffix); both staging and
# production app-node applies point at it.
data "terraform_remote_state" "apps_shared" {
  backend = "s3"
  config = {
    bucket                      = "eliza-terraform-state"
    key                         = "hetzner/apps-shared/shared.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }
}

locals {
  apps_network_id  = data.terraform_remote_state.apps_shared.outputs.apps_network_id
  apps_subnet_cidr = data.terraform_remote_state.apps_shared.outputs.apps_subnet_cidr
  tenant_db_host   = data.terraform_remote_state.apps_shared.outputs.tenant_db_private_ip
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
  # Caddy admin API — the control plane adds/removes per-app routes live
  # (apps-ingress-provisioner). Same tight allowlist as SSH; never public.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "2019"
    source_ips = var.operator_ingress_cidrs
  }
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
    tenant_db_host    = local.tenant_db_host
    cloud_api_origin  = var.cloud_api_origin
  })

  # Allow in-place rename via Hetzner Console without TF drift (matches control-plane).
  lifecycle {
    ignore_changes = [user_data, image, name, ssh_keys]
  }
}

resource "hcloud_server_network" "app_node" {
  for_each = hcloud_server.app_node

  server_id  = each.value.id
  network_id = local.apps_network_id
  # staging + production app nodes share the apps-shared subnet, so the private-IP
  # offset MUST be partitioned per environment or the prod node #1 collides with
  # the staging node #1 (both at host 21 → "API request failed" on attach).
  # staging → 21,22,…  production → 31,32,… (DB node is host 10).
  ip = cidrhost(
    local.apps_subnet_cidr,
    (var.environment == "production" ? 30 : 20) + tonumber(each.key),
  )
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
