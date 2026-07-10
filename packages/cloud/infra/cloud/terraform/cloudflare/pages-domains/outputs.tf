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
