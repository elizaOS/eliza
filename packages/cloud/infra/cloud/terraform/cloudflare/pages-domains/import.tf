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

import {
  for_each = local.pages_domains
  to       = cloudflare_dns_record.pages[each.key]
  id       = "${var.cloudflare_zone_id}/${one(data.cloudflare_dns_records.existing_pages[each.key].result).id}"
}
