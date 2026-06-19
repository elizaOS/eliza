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

# Private network that the runtime autoscaler attaches every data-plane worker
# to. Lives in the SAME Hetzner project as the control-plane VM, so each env's
# workers + their CP share one private LAN — no cross-project peering hack.
# The autoscaler reads this network's id from CONTAINERS_HCLOUD_NETWORK_IDS in
# /opt/eliza/cloud/.env.local on the CP (see node-autoscaler.ts).
resource "hcloud_network" "data_plane" {
  name     = "eliza-${var.environment}-private"
  ip_range = var.data_plane_network_cidr
  labels   = local.common_labels

  # Same convention as the apps-shared module: ignore Hetzner-side renames so
  # legacy names left over from out-of-band creation don't show as drift.
  lifecycle {
    ignore_changes = [name]
  }
}

resource "hcloud_network_subnet" "data_plane" {
  network_id   = hcloud_network.data_plane.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = var.data_plane_subnet_cidr
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

resource "cloudflare_dns_record" "control_plane" {
  for_each = hcloud_server.control_plane

  zone_id = var.cloudflare_zone_id
  name    = "${var.control_plane_hostname_prefix}-${var.environment}-${each.key}.elizacloud.ai"
  type    = "A"
  content = each.value.ipv4_address
  # CF Workers fetch `https://eliza-${env}-N.elizacloud.ai` to proxy agent
  # traffic to the agent-router on this VM (cloud-api Worker
  # AGENT_ROUTER_ORIGIN_HOST). With proxied=true, CF terminates TLS with the
  # visitor and accepts whatever cert the origin presents (zone SSL = "Full"
  # — see cloud-init/bootstrap.yaml.tftpl which generates a self-signed
  # *.elizacloud.ai cert at boot). With proxied=false the Worker hits the
  # origin directly and verifies the self-signed cert — that fails, and
  # dashboard chat bridge calls return "Sandbox bridge is unreachable".
  # TTL must be 1 ("Auto") when proxied=true per Cloudflare API.
  ttl     = 1
  proxied = true
  comment = "eliza control-plane VM ${each.value.name} (managed by terraform/hetzner/control-plane)"

  # Decouple DNS cutover from VM creation. Without this, an apply that
  # spawns a new VM (for_each key gets a new ipv4) would atomically flip the
  # A record `content` to the new IP — before cloud-init / nginx / agent-
  # router had converged on the new box. With ignore_changes = [content], TF
  # keeps the record in state and continues to manage name/type/ttl/proxied/
  # comment, but never touches `content`. The operator opts in to the actual
  # cutover after validating the new VM, by either:
  #   - editing the A record in the Cloudflare dashboard (preferred — no
  #     destroy+create dance), OR
  #   - `terraform apply -replace=cloudflare_dns_record.control_plane["N"]`
  #     which causes a ~5s NXDOMAIN window during destroy+create. The TTL=1
  #     ("Auto", proxied) edge cache mostly masks it, but not zero-risk;
  #     prefer the dashboard edit for prod cutovers.
  lifecycle {
    ignore_changes = [content]
  }
}

# Headscale coordination-server DNS record. SIBLING of control_plane above —
# same CP ipv4, different (stable) hostname. This is part 1 of codifying the
# headscale-on-CP cutover that was previously a manual `dig`/dashboard step on
# every CP rebuild (a DR gap). The nginx vhost + Let's Encrypt cert that serve
# this hostname are provisioned by the arm-headscale-control-plane workflow
# (packages/scripts/cloud/admin/arm-headscale-control-plane.mjs) — that script
# runs AFTER this record exists, so HTTP-01 issuance can resolve the name.
#
# Headscale is singular per env (one coordination server), so this binds to the
# first control-plane VM ("1"). A multi-CP HA topology would need a different
# strategy (LB / floating IP) and is out of scope here.
#
# proxied=false (unlike the agent-router record): the headscale TS2021/noise
# control protocol needs a raw HTTP/1.1 Upgrade passthrough that the Cloudflare
# proxy edge mangles, and the CP terminates real TLS via a Let's Encrypt cert.
# Routing through CF would both break the Upgrade handshake AND hide the origin
# from the HTTP-01 challenge. ttl=300 is a normal DNS-only TTL (ttl=1/"Auto" is
# only valid when proxied=true).
resource "cloudflare_dns_record" "headscale" {
  for_each = { for k, v in hcloud_server.control_plane : k => v if k == "1" }

  zone_id = var.cloudflare_zone_id
  name    = var.headscale_hostname
  type    = "A"
  content = each.value.ipv4_address
  ttl     = 300
  proxied = false
  comment = "eliza headscale coordination server on ${each.value.name} (managed by terraform/hetzner/control-plane)"

  # Same cutover-decoupling rationale as control_plane above: an apply that
  # spawns a replacement CP must NOT atomically flip this A record to the new
  # IP before the arm workflow has stood up nginx + the LE cert on the new box
  # (agent nodes would fail their noise handshake mid-cutover). TF keeps the
  # record's name/type/ttl/proxied/comment managed but never touches `content`;
  # the operator cuts over deliberately (dashboard edit, or
  # `terraform apply -replace=cloudflare_dns_record.headscale["1"]`) once the
  # new CP's headscale is armed and healthy.
  lifecycle {
    ignore_changes = [content]
  }
}
