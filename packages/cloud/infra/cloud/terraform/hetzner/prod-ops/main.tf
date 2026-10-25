/**
 * Two disposable-capacity hosts reserve a protected lane for production
 * operations. Each registration accepts one job, while a revisioned hostname
 * lets Terraform replace a host without depending on the host being repaired.
 */

locals {
  bootstrap_revision = substr(sha256(join("\n", [
    file("${path.module}/cloud-init/bootstrap.yaml.tftpl"),
    var.hcloud_image,
    var.hcloud_location,
    var.hcloud_server_type,
    jsonencode(var.ssh_public_keys),
  ])), 0, 8)

  runner_slots = {
    for index in range(var.runner_count) : "prod-ops-${index + 1}" => {
      name = "eliza-prod-ops-${index + 1}-${local.bootstrap_revision}"
      slot = "prod-ops-${index + 1}"
    }
  }

  labels = {
    "managed-by"  = "terraform"
    "environment" = "production"
    "role"        = "github-actions-prod-ops"
  }
}

resource "hcloud_firewall" "prod_ops" {
  name   = "eliza-prod-ops"
  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.operator_ingress_cidrs
    description = "Core-admin SSH bootstrap and recovery"
  }
}

resource "hcloud_server" "prod_ops" {
  for_each = local.runner_slots

  name         = each.value.name
  location     = var.hcloud_location
  server_type  = var.hcloud_server_type
  image        = var.hcloud_image
  firewall_ids = [hcloud_firewall.prod_ops.id]
  labels = merge(local.labels, {
    "runner-slot" = each.value.slot
  })

  user_data = templatefile("${path.module}/cloud-init/bootstrap.yaml.tftpl", {
    hostname          = each.value.name
    operator_ssh_keys = var.ssh_public_keys
    runner_slot       = each.value.slot
  })

  lifecycle {
    create_before_destroy = true
  }
}
