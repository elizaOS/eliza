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
