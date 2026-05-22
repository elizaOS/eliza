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
  for_each = { for idx, key in var.ssh_public_keys : idx => key }

  name       = "eliza-cp-${var.environment}-op-${each.key}"
  public_key = each.value
  labels     = local.common_labels
}

resource "hcloud_server" "control_plane" {
  for_each = toset([for i in range(var.control_plane_count) : tostring(i + 1)])

  name        = "eliza-cp-${var.environment}-${each.value}"
  location    = var.hcloud_location
  server_type = var.hcloud_server_type
  image       = var.hcloud_image
  ssh_keys    = [for k in hcloud_ssh_key.operators : k.id]
  labels = merge(local.common_labels, {
    "control-plane-index" = each.value
  })

  user_data = templatefile("${path.module}/cloud-init/bootstrap.yaml.tftpl", {
    hostname      = "eliza-cp-${var.environment}-${each.value}"
    deploy_branch = var.deploy_branch
  })

  # Keep server alive across refactors: changing labels or user_data
  # shouldn't recreate the box, only update in place where possible.
  lifecycle {
    ignore_changes = [
      user_data, # bootstrap runs once at first boot
      image,     # updating image rebuilds — explicit `terraform taint` to opt in
    ]
  }
}

resource "cloudflare_dns_record" "control_plane" {
  for_each = hcloud_server.control_plane

  zone_id = var.cloudflare_zone_id
  name    = "${var.control_plane_hostname_prefix}-${var.environment}-${each.key}.elizacloud.ai"
  type    = "A"
  content = each.value.ipv4_address
  ttl     = 60
  proxied = false
  comment = "eliza control-plane VM ${each.value.name} (managed by terraform/hetzner/control-plane)"
}
