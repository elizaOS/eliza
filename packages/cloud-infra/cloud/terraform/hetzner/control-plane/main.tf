locals {
  # Tags applied to every Hetzner Cloud resource managed here. Mirrors the
  # data-plane convention (`managed-by: eliza-cloud`) used by the runtime
  # autoscaler so a single search in the Hetzner Console reveals everything.
  common_labels = {
    "managed-by"  = "eliza-cloud"
    "tier"        = "control-plane"
    "environment" = var.environment
  }
}

resource "hcloud_ssh_key" "operators" {
  # Key the map by a short SHA-256 prefix of the public key rather than the
  # list index — keeps Terraform plans stable when operators are
  # inserted/reordered in `var.ssh_public_keys`.
  for_each = { for key in var.ssh_public_keys : substr(sha256(key), 0, 12) => key }

  name       = "eliza-op-${var.environment}-${each.key}"
  public_key = each.value
  labels     = local.common_labels
}

resource "hcloud_server" "control_plane" {
  for_each = toset([for i in range(var.control_plane_count) : tostring(i + 1)])

  # Naming: `eliza-${index}` — short, matches the data-plane convention
  # `eliza-core-<hex>` and supports the in-place rename from the legacy
  # `milady` VM. The environment lives in labels, not the hostname, so the
  # prod/staging distinction shows up in the Hetzner Console filter
  # without bloating the hostname every operator types into SSH.
  #
  # No hcloud_firewall is attached: the CP runs agent-router (HTTP),
  # headscale (HTTP/UDP), and other services that need inbound from the
  # public internet OR from agent containers, and we don't have a clean
  # inventory of every bound port. Defense is pubkey-only SSH + per-service
  # auth on the bound ports.
  name        = "eliza-${var.environment}-${each.value}"
  location    = var.hcloud_location
  server_type = var.hcloud_server_type
  image       = var.hcloud_image
  ssh_keys    = [for k in hcloud_ssh_key.operators : k.id]
  labels = merge(local.common_labels, {
    "control-plane-index" = each.value
  })

  user_data = templatefile("${path.module}/cloud-init/bootstrap.yaml.tftpl", {
    hostname          = "eliza-${var.environment}-${each.value}"
    deploy_branch     = var.deploy_branch
    operator_ssh_keys = var.ssh_public_keys
  })

  # Keep server alive across refactors: changing labels or user_data
  # shouldn't recreate the box, only update in place where possible.
  #
  # OPS NOTE: changes to cloud-init/bootstrap.yaml.tftpl (nginx vhost, cert
  # generation, git clone retry, etc.) are no-ops on already-provisioned VMs
  # because user_data is in ignore_changes. To roll a bootstrap fix onto an
  # existing CP, run `terraform taint hcloud_server.control_plane["<idx>"]`
  # then `apply` — recreates the VM, losing local state (headscale DB,
  # cloudflared creds, /opt/eliza checkout). Plan that ahead of the apply.
  lifecycle {
    ignore_changes = [
      user_data,   # bootstrap runs once at first boot
      image,       # updating image rebuilds — explicit `terraform taint` to opt in
      name,        # legacy VMs may not follow the env-prefixed naming convention; renaming is out of band
      ssh_keys,    # operator key rotations don't recreate the box (keys are baked into authorized_keys at boot)
      server_type, # cross-arch flips (cax21 ARM ↔ cpx32 x86) are ForceNew, not in-place; would wipe headscale + cloudflared state on adopt-existing-vm import. Resize must go through `terraform taint` or out-of-band `hcloud server change-type` before plan/apply.
    ]
  }
}

# Control-plane A record. Two deliberate choices below:
#
# (a) proxied = false
#     headscale on this VM serves WireGuard control over UDP, which the
#     Cloudflare HTTP proxy cannot pass. HTTP egress for the agent-router /
#     dashboard chat bridge does NOT come through this hostname — cloudflared
#     tunnel handles that on a separate proxied hostname with its own origin
#     cert. So we want a plain unproxied A record here: agent VMs need the raw
#     IP for the headscale UDP handshake, and Workers that still hit this name
#     get a direct origin connection (no CF cert-in-the-middle).
#
# (b) lifecycle.ignore_changes = [content]
#     The prod migration plan revealed that creating a new VM in the same
#     apply would atomically flip the A record `content` to the new IP before
#     cloud-init / headscale / agent-router had converged — cutting users
#     over to an unhealthy origin with no operator gate. Keeping the resource
#     in state but ignoring `content` decouples DNS cutover from VM creation:
#     `terraform apply` creates the VM and leaves the existing A record
#     pointing at the old box. When the new CP is validated, the operator
#     opts in to the flip with:
#       terraform apply -replace=cloudflare_dns_record.control_plane[\"N\"]
#     (where N is the control_plane_count index — "1", "2", ...).
resource "cloudflare_dns_record" "control_plane" {
  for_each = hcloud_server.control_plane

  zone_id = var.cloudflare_zone_id
  name    = "${var.control_plane_hostname_prefix}-${var.environment}-${each.key}.elizacloud.ai"
  type    = "A"
  content = each.value.ipv4_address
  # ttl=60 is the lowest non-"Auto" value Cloudflare accepts for unproxied
  # records. Was 1 ("Auto") only because proxied=true required it.
  ttl     = 60
  proxied = false
  comment = "eliza control-plane VM ${each.value.name} (managed by terraform/hetzner/control-plane)"

  lifecycle {
    # See block comment above the resource for the why.
    ignore_changes = [content]
  }
}
