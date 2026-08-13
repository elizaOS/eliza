output "pages_domains" {
  description = "Canonical Pages project/domain bindings and certificate state observed after apply."
  value = {
    for key, binding in cloudflare_pages_domain.public : key => {
      project_name          = local.canonical_pages_domains[key].project_name
      domain                = binding.name
      status                = binding.status
      certificate_authority = binding.certificate_authority
      cname_target          = cloudflare_dns_record.pages[key].content
    }
  }
}

output "redirect_dns" {
  description = "Exact and wildcard legacy DNS inventory owned by the redirect ingress."
  value = {
    exact = {
      for key, domain in local.legacy_redirect_domains : key => {
        id      = cloudflare_dns_record.pages[key].id
        domain  = domain.domain
        content = cloudflare_dns_record.pages[key].content
        proxied = cloudflare_dns_record.pages[key].proxied
      }
    }
    staging_agent = {
      for origin, record in cloudflare_dns_record.staging_agent_wildcard : origin => {
        id      = record.id
        name    = record.name
        content = record.content
        proxied = record.proxied
      }
    }
    deep_wildcards = {
      for key, record in cloudflare_dns_record.legacy_redirect_wildcard : key => {
        id      = record.id
        name    = record.name
        content = record.content
        proxied = record.proxied
      }
    }
  }
}

output "canonical_edge" {
  description = "Canonical service and wildcard DNS plus additive advanced-certificate generations."
  value = {
    dns_records = {
      for key, record in cloudflare_dns_record.canonical_edge_wildcard : key => {
        id      = record.id
        name    = record.name
        content = record.content
        proxied = record.proxied
      }
    }
    service_dns_records = {
      for key, record in cloudflare_dns_record.canonical_service : key => {
        id      = record.id
        name    = record.name
        content = record.content
        proxied = record.proxied
      }
    }
    certificate_packs = {
      for key, pack in cloudflare_certificate_pack.canonical_edge : key => {
        id     = pack.id
        hosts  = pack.hosts
        status = pack.status
      }
    }
  }
}

output "railway_tunnel_dns" {
  description = "DNS-only canonical tunnel records whose exact targets and verification values originate in Railway."
  value = {
    for key, record in cloudflare_dns_record.railway_tunnel : key => {
      id      = record.id
      name    = record.name
      type    = record.type
      content = record.content
      ttl     = record.ttl
      proxied = record.proxied
      roles   = var.railway_tunnel_dns_records[key].roles
    }
  }
}

output "legacy_certificate_packs" {
  description = "Preserved staging-agent pack plus additive deep-wildcard redirect certificate generations."
  value = {
    staging_agent = var.environment == "staging" ? {
      id     = cloudflare_certificate_pack.staging_agent[0].id
      hosts  = cloudflare_certificate_pack.staging_agent[0].hosts
      status = cloudflare_certificate_pack.staging_agent[0].status
    } : null
    redirect = {
      for key, pack in cloudflare_certificate_pack.legacy_redirect : key => {
        id     = pack.id
        hosts  = pack.hosts
        status = pack.status
      }
    }
  }
}
