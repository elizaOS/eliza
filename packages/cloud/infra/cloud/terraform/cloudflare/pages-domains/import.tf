# Existing DNS is adopted only by operator-supplied opaque record id. Name-based
# discovery is unsafe during this migration because several hosts currently have
# records of different types or multiple origin records with the same name.
locals {
  # Every canonical Pages binding exists before this root is allowed to plan:
  # operators attach it to eliza-app during the no-DNS-gap cutover, then this
  # deterministic import adopts it. Existing state addresses are a no-op.
  pages_domain_imports = local.canonical_pages_domains

  pages_dns_imports = {
    for key, domain in local.pages_dns_domains : key => {
      zone_id   = domain.zone_id
      record_id = lookup(var.dns_record_import_ids, "pages/${key}", "")
    } if lookup(var.dns_record_import_ids, "pages/${key}", "") != ""
  }

  canonical_edge_dns_imports = {
    for key, record in local.canonical_edge_wildcard_records : key => {
      zone_id   = var.eliza_app_zone_id
      record_id = lookup(var.dns_record_import_ids, "canonical-edge/${key}", "")
    } if lookup(var.dns_record_import_ids, "canonical-edge/${key}", "") != ""
  }

  canonical_service_dns_imports = {
    for key, record in local.canonical_service_records : key => {
      zone_id   = var.eliza_app_zone_id
      record_id = lookup(var.dns_record_import_ids, "canonical-service/${key}", "")
    } if lookup(var.dns_record_import_ids, "canonical-service/${key}", "") != ""
  }

  railway_tunnel_dns_imports = {
    for key, record in var.railway_tunnel_dns_records : key => {
      zone_id   = var.eliza_app_zone_id
      record_id = lookup(var.dns_record_import_ids, "railway-tunnel/${key}", "")
    } if lookup(var.dns_record_import_ids, "railway-tunnel/${key}", "") != ""
  }

  legacy_staging_agent_dns_imports = {
    for origin in keys(local.staging_agent_wildcard_records) : origin => {
      zone_id   = var.elizacloud_ai_zone_id
      record_id = lookup(var.dns_record_import_ids, "legacy-staging-agent/${origin}", "")
    } if lookup(var.dns_record_import_ids, "legacy-staging-agent/${origin}", "") != ""
  }

  legacy_edge_dns_imports = {
    for key, record in local.legacy_redirect_wildcard_records : key => {
      zone_id   = var.elizacloud_ai_zone_id
      record_id = lookup(var.dns_record_import_ids, "legacy-edge/${key}", "")
    } if lookup(var.dns_record_import_ids, "legacy-edge/${key}", "") != ""
  }

  canonical_edge_certificate_imports = {
    for key, pack in var.canonical_edge_certificate_packs : key => pack
    if pack.id != ""
  }

  legacy_redirect_certificate_imports = {
    for key, pack in var.legacy_redirect_certificate_packs : key => pack
    if pack.id != ""
  }
}

import {
  for_each = local.pages_domain_imports
  to       = cloudflare_pages_domain.public[each.key]
  id       = "${var.cloudflare_account_id}/${each.value.project_name}/${each.value.domain}"
}

import {
  for_each = local.pages_dns_imports
  to       = cloudflare_dns_record.pages[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = local.canonical_edge_dns_imports
  to       = cloudflare_dns_record.canonical_edge_wildcard[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = local.canonical_service_dns_imports
  to       = cloudflare_dns_record.canonical_service[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = local.railway_tunnel_dns_imports
  to       = cloudflare_dns_record.railway_tunnel[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = local.legacy_staging_agent_dns_imports
  to       = cloudflare_dns_record.staging_agent_wildcard[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = local.legacy_edge_dns_imports
  to       = cloudflare_dns_record.legacy_redirect_wildcard[each.key]
  id       = "${each.value.zone_id}/${each.value.record_id}"
}

import {
  for_each = var.environment == "staging" ? toset(["staging"]) : toset([])
  to       = cloudflare_certificate_pack.staging_agent[0]
  id       = "${var.elizacloud_ai_zone_id}/${var.staging_agent_certificate_pack_id}"
}

import {
  for_each = local.canonical_edge_certificate_imports
  to       = cloudflare_certificate_pack.canonical_edge[each.key]
  id       = "${var.eliza_app_zone_id}/${each.value.id}"
}

import {
  for_each = local.legacy_redirect_certificate_imports
  to       = cloudflare_certificate_pack.legacy_redirect[each.key]
  id       = "${var.elizacloud_ai_zone_id}/${each.value.id}"
}
