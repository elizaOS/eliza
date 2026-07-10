# Adopt the live Pages bindings and their auto-created DNS records. Domain IDs
# are deterministic; DNS record IDs are resolved read-only by exact name so no
# opaque production identifier is committed. The live zone already contains
# exactly one CNAME for each name. A missing/duplicate result fails the first
# plan instead of creating or choosing a record ambiguously.
data "cloudflare_dns_records" "existing_pages" {
  for_each = local.pages_domains

  zone_id   = var.cloudflare_zone_id
  type      = "CNAME"
  max_items = 2
  name = {
    exact = each.value.domain
  }
}

import {
  for_each = local.pages_domains
  to       = cloudflare_pages_domain.public[each.key]
  id       = "${var.cloudflare_account_id}/${each.value.project_name}/${each.value.domain}"
}

data "cloudflare_dns_records" "existing_staging_agent_wildcard" {
  count = var.environment == "staging" ? 1 : 0

  zone_id   = var.cloudflare_zone_id
  type      = "A"
  max_items = 10
  name = {
    exact = "*.staging.elizacloud.ai"
  }
}

import {
  for_each = local.staging_agent_wildcard_records
  to       = cloudflare_dns_record.staging_agent_wildcard[each.key]
  id = "${var.cloudflare_zone_id}/${one([
    for record in data.cloudflare_dns_records.existing_staging_agent_wildcard[0].result : record.id
    if record.content == each.value
  ])}"
}

import {
  for_each = var.environment == "staging" ? toset(["staging"]) : toset([])
  to       = cloudflare_certificate_pack.staging_agent[0]
  id       = "${var.cloudflare_zone_id}/${var.staging_agent_certificate_pack_id}"
}

import {
  for_each = local.pages_domains
  to       = cloudflare_dns_record.pages[each.key]
  id       = "${var.cloudflare_zone_id}/${one(data.cloudflare_dns_records.existing_pages[each.key].result).id}"
}
