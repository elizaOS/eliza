locals {
  canonical_pages_domains = var.environment == "production" ? {
    marketing = {
      project_name = "eliza-app"
      domain       = "eliza.app"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.eliza_app_zone_id
    }
    cloud_app = {
      project_name = "eliza-app"
      domain       = "cloud.eliza.app"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.eliza_app_zone_id
    }
    marketing_www = {
      project_name = "eliza-app"
      domain       = "www.eliza.app"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.eliza_app_zone_id
    }
    } : {
    marketing = {
      project_name = "eliza-app"
      domain       = "staging.eliza.app"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.eliza_app_zone_id
    }
    cloud_app = {
      project_name = "eliza-app"
      domain       = "cloud-staging.eliza.app"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.eliza_app_zone_id
    }
  }

  # These records are only ingress for the legacy-zone Worker redirect routes.
  # The Pages target is a fail-closed origin if a redirect route is missing; no
  # legacy hostname is attached to Pages or allowed to become a second product.
  legacy_redirect_domains = var.environment == "production" ? {
    console = {
      domain       = "elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    app = {
      domain       = "app.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_www = {
      domain       = "www.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_docs = {
      domain       = "docs.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_api = {
      domain       = "api.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_blob = {
      domain       = "blob.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_plugins = {
      domain       = "plugins.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_relay = {
      domain       = "relay.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_x402 = {
      domain       = "x402.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    } : {
    console = {
      domain       = "staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    app = {
      domain       = "app-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_api = {
      domain       = "api-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_blob = {
      domain       = "blob-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_plugins = {
      domain       = "plugins.staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_relay = {
      domain       = "relay-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
    legacy_x402 = {
      domain       = "x402-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
      zone_id      = var.elizacloud_ai_zone_id
    }
  }

  pages_dns_domains = merge(local.canonical_pages_domains, local.legacy_redirect_domains)

  canonical_edge_wildcard_hostnames = var.environment == "production" ? toset([
    "*.cloud.eliza.app",
    "*.sites.eliza.app",
    ]) : toset([
    "*.cloud-staging.eliza.app",
    "*.sites-staging.eliza.app",
  ])

  canonical_edge_wildcard_records = {
    for record in flatten([
      for hostname in local.canonical_edge_wildcard_hostnames : [
        for origin in var.canonical_edge_wildcard_origins : {
          key      = "${hostname}|${origin}"
          hostname = hostname
          origin   = origin
        }
      ]
    ]) : record.key => record
  }

  canonical_service_records = {
    for record in flatten([
      for hostname, origins in var.canonical_service_origins : [
        for origin in origins : {
          key      = "${hostname}|${origin}"
          hostname = hostname
          origin   = origin
        }
      ]
    ]) : record.key => record
  }

  # Preserve the original resource address for the imported staging agent DNS.
  # New legacy deep-wildcard redirect records use the generalized resource.
  staging_agent_wildcard_records = var.environment == "staging" ? {
    for origin in var.staging_agent_wildcard_origins : origin => origin
  } : {}

  legacy_redirect_wildcard_records = {
    for record in flatten([
      for hostname, origins in var.legacy_redirect_wildcard_origins : [
        for origin in origins : {
          key      = "${hostname}|${origin}"
          hostname = hostname
          origin   = origin
        }
      ]
    ]) : record.key => record
  }
}

# Wrangler owns Pages deployments and branch selection. Terraform owns the
# stable public-domain attachment so a dashboard edit or account rebuild shows
# up as plan drift instead of silently routing staging to production.
resource "cloudflare_pages_domain" "public" {
  for_each = local.canonical_pages_domains

  account_id   = var.cloudflare_account_id
  project_name = each.value.project_name
  name         = each.value.domain
}

# The `develop.` target is Cloudflare Pages' supported custom-branch-alias
# architecture. Exact records are imported by opaque ID before Terraform owns
# them, including canonical names that already exist outside this state.
resource "cloudflare_dns_record" "pages" {
  for_each = local.pages_dns_domains

  zone_id = each.value.zone_id
  name    = each.value.domain
  type    = "CNAME"
  content = each.value.cname_target
  ttl     = 1
  proxied = true
  comment = "Unified eliza-app ${var.environment} domain (managed by terraform/cloudflare/pages-domains)"

  depends_on = [cloudflare_pages_domain.public]
}

# The live legacy staging pack and matching DNS predate this root. Keep their
# resource addresses and exact inputs immutable while the Worker issues 308s.
resource "cloudflare_dns_record" "staging_agent_wildcard" {
  for_each = local.staging_agent_wildcard_records

  zone_id = var.elizacloud_ai_zone_id
  name    = "*.staging.elizacloud.ai"
  type    = "A"
  content = each.value
  ttl     = 1
  proxied = true
  comment = "Legacy staging dedicated-agent redirect ingress (managed by terraform/cloudflare/pages-domains)"
}

# Both managed-agent and hosted-site hostnames are two labels below eliza.app.
# Worker routes require these records to be proxied; Universal SSL does not
# cover their depth, so the additive advanced packs below are also mandatory.
resource "cloudflare_dns_record" "canonical_edge_wildcard" {
  for_each = local.canonical_edge_wildcard_records

  zone_id = var.eliza_app_zone_id
  name    = each.value.hostname
  type    = "A"
  content = each.value.origin
  ttl     = 1
  proxied = true
  comment = "Canonical ${var.environment} Worker wildcard ingress (managed by terraform/cloudflare/pages-domains)"
}

# An exact Worker route is not an origin: Cloudflare still requires a proxied
# DNS record before api/blob/plugins/relay/x402 requests can enter the route. These
# names use Universal SSL and preserve their own reviewed origin inventory.
resource "cloudflare_dns_record" "canonical_service" {
  for_each = local.canonical_service_records

  zone_id = var.eliza_app_zone_id
  name    = each.value.hostname
  type    = "A"
  content = each.value.origin
  ttl     = 1
  proxied = true
  comment = "Canonical ${var.environment} Worker service ingress (managed by terraform/cloudflare/pages-domains)"
}

# Railway supplies every target and verification value after the custom domain
# is attached. Keep those values in reviewed protected inventory instead of
# deriving them from a service id. These records intentionally remain DNS-only:
# Railway terminates TLS, including for the two-label wildcard, so this path
# does not depend on a Cloudflare advanced certificate.
resource "cloudflare_dns_record" "railway_tunnel" {
  for_each = var.railway_tunnel_dns_records

  zone_id = var.eliza_app_zone_id
  name    = each.value.name
  type    = upper(each.value.type)
  content = each.value.content
  ttl     = 1
  proxied = false
  comment = "Canonical ${var.environment} Railway tunnel ingress (managed by terraform/cloudflare/pages-domains)"
}

# Deep legacy site/tunnel names cannot use the one-label *.elizacloud.ai DNS
# record. Keep their inventory explicit so direct Railway/Caddy origins are not
# accidentally converted to redirect ingress without a reviewed plan.
resource "cloudflare_dns_record" "legacy_redirect_wildcard" {
  for_each = local.legacy_redirect_wildcard_records

  zone_id = var.elizacloud_ai_zone_id
  name    = each.value.hostname
  type    = "A"
  content = each.value.origin
  ttl     = 1
  proxied = true
  comment = "Legacy ${var.environment} Worker wildcard redirect ingress (managed by terraform/cloudflare/pages-domains)"
}

# This imported paid pack remains modeled separately from all new packs. Its
# host inventory must be copied exactly from Cloudflare; prevent_destroy turns
# accidental replacement into a failed plan rather than a TLS outage.
resource "cloudflare_certificate_pack" "staging_agent" {
  count = var.environment == "staging" ? 1 : 0

  zone_id               = var.elizacloud_ai_zone_id
  certificate_authority = "google"
  hosts                 = var.staging_agent_certificate_hosts
  type                  = "advanced"
  validation_method     = "txt"
  validity_days         = 90
  cloudflare_branding   = false

  lifecycle {
    prevent_destroy = true
  }
}

# Pack keys are generations, not mutable names. Preserve an imported pack under
# its existing key and add a new key when coverage changes. This lets the new
# certificate become active before an old pack is retired out of band.
resource "cloudflare_certificate_pack" "canonical_edge" {
  for_each = var.canonical_edge_certificate_packs

  zone_id               = var.eliza_app_zone_id
  certificate_authority = "google"
  hosts                 = each.value.hosts
  type                  = "advanced"
  validation_method     = "txt"
  validity_days         = 90
  cloudflare_branding   = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_certificate_pack" "legacy_redirect" {
  for_each = var.legacy_redirect_certificate_packs

  zone_id               = var.elizacloud_ai_zone_id
  certificate_authority = "google"
  hosts                 = each.value.hosts
  type                  = "advanced"
  validation_method     = "txt"
  validity_days         = 90
  cloudflare_branding   = false

  lifecycle {
    prevent_destroy = true
  }
}
