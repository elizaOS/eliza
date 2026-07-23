locals {
  pages_domains = var.environment == "production" ? {
    console = {
      project_name = "eliza-cloud"
      domain       = "elizacloud.ai"
      cname_target = "eliza-cloud.pages.dev"
    }
    app = {
      project_name = "eliza-app"
      domain       = "app.elizacloud.ai"
      cname_target = "eliza-app.pages.dev"
    }
    } : {
    console = {
      project_name = "eliza-cloud"
      domain       = "staging.elizacloud.ai"
      cname_target = "develop.eliza-cloud.pages.dev"
    }
    app = {
      project_name = "eliza-app"
      domain       = "app-staging.elizacloud.ai"
      cname_target = "develop.eliza-app.pages.dev"
    }
  }

  staging_agent_wildcard_records = var.environment == "staging" ? {
    for origin in var.staging_agent_wildcard_origins : origin => origin
  } : {}

  managed_frontend_edge = var.environment == "production" ? {
    suffix       = "sites.elizacloud.ai"
    wildcard     = "*.sites.elizacloud.ai"
    cname_target = "api.elizacloud.ai"
    } : {
    suffix       = "sites.staging.elizacloud.ai"
    wildcard     = "*.sites.staging.elizacloud.ai"
    cname_target = "api-staging.elizacloud.ai"
  }
}

# Wrangler owns Pages deployments and branch selection. Terraform owns the
# stable public-domain attachment so a dashboard edit or account rebuild shows
# up as plan drift instead of silently routing staging to production.
resource "cloudflare_pages_domain" "public" {
  for_each = local.pages_domains

  account_id   = var.cloudflare_account_id
  project_name = each.value.project_name
  name         = each.value.domain
}

# Pages' domain API does not guarantee creation of a Terraform-managed DNS
# record. Keep the CNAME explicit, including the `develop.` branch alias that
# prevents staging custom domains from falling through to the production branch.
resource "cloudflare_dns_record" "pages" {
  for_each = local.pages_domains

  zone_id = var.cloudflare_zone_id
  name    = each.value.domain
  type    = "CNAME"
  content = each.value.cname_target
  ttl     = 1
  proxied = true
  comment = "${each.value.project_name} Pages ${var.environment} domain (managed by terraform/cloudflare/pages-domains)"

  depends_on = [cloudflare_pages_domain.public]
}

# The Worker route is durable in wrangler.toml, but proxied DNS must exist for
# Cloudflare to accept TLS and route an arbitrary dedicated-agent subdomain.
# Two records preserve the live origin redundancy recorded during launch QA.
resource "cloudflare_dns_record" "staging_agent_wildcard" {
  for_each = local.staging_agent_wildcard_records

  zone_id = var.cloudflare_zone_id
  name    = "*.staging.elizacloud.ai"
  type    = "A"
  content = each.value
  ttl     = 1
  proxied = true
  comment = "Staging dedicated-agent wildcard (managed by terraform/cloudflare/pages-domains)"
}

# Universal SSL covers only one label below the zone. Dedicated staging agents
# are two labels deep, so this paid advanced pack is a required routing asset.
resource "cloudflare_certificate_pack" "staging_agent" {
  count = var.environment == "staging" ? 1 : 0

  zone_id               = var.cloudflare_zone_id
  certificate_authority = "google"
  hosts                 = var.staging_agent_certificate_hosts
  type                  = "advanced"
  validation_method     = "txt"
  validity_days         = 90
  cloudflare_branding   = false

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }
}

# R2-backed managed frontends are served by the Cloud API Worker. Their hosts
# sit below a dedicated suffix so they cannot collide with agents, Pages, or
# container ingress, and the proxied wildcard sends every project slug through
# the Worker hostname resolver.
resource "cloudflare_dns_record" "managed_frontend_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = local.managed_frontend_edge.wildcard
  type    = "CNAME"
  content = local.managed_frontend_edge.cname_target
  ttl     = 1
  proxied = true
  comment = "${var.environment} managed project frontend wildcard (managed by terraform/cloudflare/pages-domains)"
}

# Universal SSL covers only one label below elizacloud.ai. Project frontends
# are deeper, so their deterministic suffix and wildcard require an advanced
# pack in both environments before publication can return a usable HTTPS URL.
resource "cloudflare_certificate_pack" "managed_frontend" {
  zone_id               = var.cloudflare_zone_id
  certificate_authority = "google"
  hosts = [
    local.managed_frontend_edge.suffix,
    local.managed_frontend_edge.wildcard,
  ]
  type                = "advanced"
  validation_method   = "txt"
  validity_days       = 90
  cloudflare_branding = false

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }
}
