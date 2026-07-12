data "cloudflare_ip_ranges" "edge" {}

locals {
  labels = merge(
    var.extra_labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      product     = "eliza-hub"
      role        = "git-forge"
    },
  )

  cloudflare_edge_cidrs = concat(
    data.cloudflare_ip_ranges.edge.ipv4_cidrs,
    data.cloudflare_ip_ranges.edge.ipv6_cidrs,
  )
  web_ingress_cidrs = var.cloudflare_proxy_web ? local.cloudflare_edge_cidrs : ["0.0.0.0/0", "::/0"]
  client_ip_header  = var.cloudflare_proxy_web ? "{http.request.header.CF-Connecting-IP}" : "{remote_host}"

  caddyfile = templatefile("${path.module}/files/Caddyfile.tftpl", {
    client_ip_header = local.client_ip_header
    web_hostname     = var.web_hostname
  })

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    operator_user            = var.operator_user
    operator_ssh_public_keys = values(var.operator_ssh_public_keys)
    caddyfile_base64         = base64encode(local.caddyfile)
    docker_daemon_base64     = filebase64("${path.module}/files/docker-daemon.json")
    fail2ban_base64          = filebase64("${path.module}/files/fail2ban-sshd.local")
    node_install_base64      = filebase64("${path.module}/files/install-node-24.sh")
    ssh_hardening_base64 = base64encode(templatefile("${path.module}/files/99-eliza-hub-sshd.conf.tftpl", {
      operator_user = var.operator_user
    }))
    unattended_upgrades_base64 = filebase64("${path.module}/files/20auto-upgrades")
  })
}

resource "hcloud_ssh_key" "operator" {
  for_each = var.operator_ssh_public_keys

  name       = each.key
  public_key = trimspace(each.value)
  labels     = local.labels
}

resource "hcloud_primary_ip" "forge" {
  name              = "${var.server_name}-ipv4"
  location          = var.location
  type              = "ipv4"
  auto_delete       = false
  delete_protection = var.enable_delete_protection
  labels            = local.labels
}

resource "hcloud_firewall" "forge" {
  name   = "${var.server_name}-firewall"
  labels = local.labels

  rule {
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Path MTU discovery and network diagnostics"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = tostring(var.operator_ssh_port)
    source_ips  = var.operator_ssh_cidrs
    description = "Key-only host administration SSH"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = local.web_ingress_cidrs
    description = "Caddy HTTP and ACME"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = local.web_ingress_cidrs
    description = "Caddy HTTPS"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = tostring(var.git_ssh_port)
    source_ips  = var.git_ssh_cidrs
    description = "Native Forgejo Git SSH"
  }
}

resource "hcloud_server" "forge" {
  name         = var.server_name
  image        = var.server_image
  server_type  = var.server_type
  location     = var.location
  backups      = var.enable_hcloud_backups
  firewall_ids = [hcloud_firewall.forge.id]
  ssh_keys     = [for key in hcloud_ssh_key.operator : key.id]
  labels       = local.labels

  delete_protection        = var.enable_delete_protection
  rebuild_protection       = var.enable_delete_protection
  shutdown_before_deletion = true

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.forge.id
    ipv6_enabled = false
  }

  user_data = local.cloud_init

  lifecycle {
    precondition {
      condition     = var.operator_ssh_port != var.git_ssh_port
      error_message = "operator_ssh_port and git_ssh_port must differ on a single-IP host."
    }

    precondition {
      condition     = var.web_hostname != var.ssh_hostname
      error_message = "web_hostname and ssh_hostname must differ because Cloudflare web proxying cannot carry native Git SSH."
    }
  }
}

resource "hcloud_rdns" "forge" {
  primary_ip_id = hcloud_primary_ip.forge.id
  ip_address    = hcloud_primary_ip.forge.ip_address
  dns_ptr       = var.ssh_hostname
}

resource "cloudflare_dns_record" "web" {
  zone_id = var.cloudflare_zone_id
  name    = var.web_hostname
  type    = "A"
  content = hcloud_primary_ip.forge.ip_address
  proxied = var.cloudflare_proxy_web
  ttl     = 1
  comment = "Eliza Hub web/API origin; managed by Terraform"
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.cloudflare_zone_id
  name    = var.ssh_hostname
  type    = "A"
  content = hcloud_primary_ip.forge.ip_address
  proxied = false
  ttl     = 300
  comment = "Eliza Hub native Git SSH; managed by Terraform"
}
