output "pages_domains" {
  description = "Pages project/domain bindings and certificate state observed after apply."
  value = {
    for key, binding in cloudflare_pages_domain.public : key => {
      project_name          = local.pages_domains[key].project_name
      domain                = binding.name
      status                = binding.status
      certificate_authority = binding.certificate_authority
      cname_target          = cloudflare_dns_record.pages[key].content
    }
  }
}

output "staging_agent_edge" {
  description = "Staging-only dedicated-agent wildcard DNS and advanced-certificate state."
  value = var.environment == "staging" ? {
    dns_records = {
      for origin, record in cloudflare_dns_record.staging_agent_wildcard : origin => {
        id      = record.id
        content = record.content
        proxied = record.proxied
      }
    }
    certificate_pack = {
      id     = cloudflare_certificate_pack.staging_agent[0].id
      hosts  = cloudflare_certificate_pack.staging_agent[0].hosts
      status = cloudflare_certificate_pack.staging_agent[0].status
    }
  } : null
}
