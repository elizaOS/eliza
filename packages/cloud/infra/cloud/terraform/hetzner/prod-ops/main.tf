/**
 * Dedicated capacity for protected production operations. The host never joins
 * the agent data plane or the general CI fleet; GitHub runner-group policy and
 * the production environment decide which trusted workflows can execute here.
 */

locals {
  runner_name = "eliza-prod-ops-1"
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
  name               = local.runner_name
  location           = var.hcloud_location
  server_type        = var.hcloud_server_type
  image              = var.hcloud_image
  firewall_ids       = [hcloud_firewall.prod_ops.id]
  delete_protection  = true
  rebuild_protection = true
  labels             = local.labels

  user_data = templatefile("${path.module}/cloud-init/bootstrap.yaml.tftpl", {
    hostname          = local.runner_name
    operator_ssh_keys = var.ssh_public_keys
  })

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [image, user_data]
  }
}
