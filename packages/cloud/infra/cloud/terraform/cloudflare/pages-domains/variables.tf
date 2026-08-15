variable "environment" {
  description = "Cloudflare Pages environment whose domain bindings this state owns."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the eliza-app Pages project."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal Cloudflare account id"
  }
}

variable "eliza_app_zone_id" {
  description = "Cloudflare zone id for the canonical eliza.app zone."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.eliza_app_zone_id))
    error_message = "eliza_app_zone_id must be a 32-character hexadecimal Cloudflare zone id"
  }
}

variable "elizacloud_ai_zone_id" {
  description = "Cloudflare zone id for the redirect-only legacy elizacloud.ai zone."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.elizacloud_ai_zone_id))
    error_message = "elizacloud_ai_zone_id must be a 32-character hexadecimal Cloudflare zone id"
  }
}

variable "dns_record_import_ids" {
  description = <<-EOT
    Existing DNS record ids keyed by Terraform inventory address. Exact records
    use pages/<resource-key>; Worker A records use canonical-edge/<host>|<ip>,
    canonical-service/<host>|<ip>, railway-tunnel/<logical-key>,
    legacy-edge/<host>|<ip>, or legacy-staging-agent/<ip>. Leave out only
    genuinely new records.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for key, record_id in var.dns_record_import_ids :
      can(regex("^(pages|canonical-edge|canonical-service|railway-tunnel|legacy-edge|legacy-staging-agent)/.+$", key)) &&
      can(regex("^[0-9a-f]{32}$", record_id))
    ])
    error_message = "dns_record_import_ids keys must use a documented inventory prefix and values must be 32-character hexadecimal DNS record ids"
  }
}

variable "railway_tunnel_dns_records" {
  description = <<-EOT
    Reviewed Cloudflare DNS inventory returned by Railway for the canonical
    tunnel-proxy apex and wildcard custom domains. Values are provider-owned
    and must be copied exactly from Railway; Terraform deliberately does not
    derive a Railway target, verification token, or ACME delegation target.
  EOT
  type = map(object({
    name    = string
    type    = string
    content = string
    roles   = set(string)
  }))
  default = {}

  validation {
    condition = length(var.railway_tunnel_dns_records) == 0 || (
      alltrue([
        for required_role in [
          "apex-routing",
          "apex-verification",
          "wildcard-routing",
          "wildcard-certificate",
          "wildcard-verification",
          ] : length([
            for record in values(var.railway_tunnel_dns_records) : record
            if contains(record.roles, required_role)
        ]) == 1
        ]) && alltrue([
        for key in keys(var.railway_tunnel_dns_records) :
        can(regex("^[a-z0-9][a-z0-9-]*$", key))
      ])
    )
    error_message = "railway_tunnel_dns_records must cover each documented apex/wildcard routing, verification, and certificate role exactly once; record keys must be stable lowercase kebab-case names"
  }

  validation {
    condition = alltrue(flatten([
      for record in values(var.railway_tunnel_dns_records) : [
        for role in record.roles :
        contains([
          "apex-routing",
          "apex-verification",
          "wildcard-routing",
          "wildcard-certificate",
          "wildcard-verification",
          ], role) && (
          role == "apex-routing" ? (
            record.name == (var.environment == "production" ? "tunnel.eliza.app" : "tunnel-staging.eliza.app") &&
            upper(record.type) == "CNAME"
            ) : role == "wildcard-routing" ? (
            record.name == (var.environment == "production" ? "*.tunnel.eliza.app" : "*.tunnel-staging.eliza.app") &&
            upper(record.type) == "CNAME"
          ) : role == "wildcard-certificate" ? upper(record.type) == "CNAME" :
          upper(record.type) == "TXT"
        )
      ]
    ]))
    error_message = "Railway tunnel DNS roles must use the canonical environment apex/wildcard names and the provider-required CNAME/TXT record types"
  }

  validation {
    condition = length(distinct([
      for record in values(var.railway_tunnel_dns_records) :
      "${lower(record.name)}|${upper(record.type)}|${record.content}"
      ])) == length(var.railway_tunnel_dns_records) && alltrue([
      for record in values(var.railway_tunnel_dns_records) :
      contains(["CNAME", "TXT"], upper(record.type)) &&
      length(record.roles) > 0 &&
      length(trimspace(record.content)) > 0 &&
      (
        record.name == (var.environment == "production" ? "tunnel.eliza.app" : "tunnel-staging.eliza.app") ||
        record.name == (var.environment == "production" ? "*.tunnel.eliza.app" : "*.tunnel-staging.eliza.app") ||
        endswith(record.name, var.environment == "production" ? ".tunnel.eliza.app" : ".tunnel-staging.eliza.app")
      )
    ])
    error_message = "Railway tunnel DNS records must be unique, non-empty CNAME/TXT values scoped beneath the canonical tunnel hostname for this environment"
  }
}

variable "canonical_edge_wildcard_origins" {
  description = "Reviewed IPv4 origin inventory for both canonical managed-agent and hosted-site wildcard DNS records in this environment."
  type        = set(string)
  default     = []

  validation {
    condition = length(var.canonical_edge_wildcard_origins) > 0 && alltrue([
      for address in var.canonical_edge_wildcard_origins :
      can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")
    ])
    error_message = "canonical_edge_wildcard_origins must contain at least one reviewed IPv4 address"
  }
}

variable "canonical_service_origins" {
  description = "Reviewed IPv4 origin inventory for every exact canonical Worker service hostname in this environment."
  type        = map(set(string))
  default     = {}

  validation {
    condition = alltrue([
      for origins in values(var.canonical_service_origins) :
      length(origins) > 0 && alltrue([
        for address in origins :
        can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")
      ])
    ])
    error_message = "every canonical service hostname must have at least one reviewed IPv4 origin"
  }

  validation {
    condition = length(setsubtract(
      var.environment == "production" ? toset([
        "api.eliza.app",
        "blob.eliza.app",
        "plugins.eliza.app",
        "relay.eliza.app",
        "x402.eliza.app",
        ]) : toset([
        "api-staging.eliza.app",
        "blob-staging.eliza.app",
        "plugins-staging.eliza.app",
        "relay-staging.eliza.app",
        "x402-staging.eliza.app",
      ]),
      toset(keys(var.canonical_service_origins)),
      )) == 0 && length(setsubtract(
      toset(keys(var.canonical_service_origins)),
      var.environment == "production" ? toset([
        "api.eliza.app",
        "blob.eliza.app",
        "plugins.eliza.app",
        "relay.eliza.app",
        "x402.eliza.app",
        ]) : toset([
        "api-staging.eliza.app",
        "blob-staging.eliza.app",
        "plugins-staging.eliza.app",
        "relay-staging.eliza.app",
        "x402-staging.eliza.app",
      ]),
    )) == 0
    error_message = "canonical_service_origins must contain exactly the canonical Worker service inventory for this environment"
  }
}

variable "canonical_edge_certificate_packs" {
  description = "Additive advanced-certificate generations for canonical agent/site wildcards. Set id to import an existing generation; add a new map key instead of editing one."
  type = map(object({
    id    = optional(string, "")
    hosts = set(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for pack in values(var.canonical_edge_certificate_packs) :
      (pack.id == "" || can(regex("^[0-9a-f-]{8,}$", pack.id))) &&
      contains(pack.hosts, "eliza.app")
    ])
    error_message = "every canonical edge certificate generation must include eliza.app and any import id must be a Cloudflare certificate pack id"
  }

  validation {
    condition = alltrue([
      for required_host in(
        var.environment == "production" ?
        ["*.cloud.eliza.app", "*.sites.eliza.app"] :
        ["*.cloud-staging.eliza.app", "*.sites-staging.eliza.app"]
        ) : contains(flatten([
          for pack in values(var.canonical_edge_certificate_packs) : tolist(pack.hosts)
      ]), required_host)
    ])
    error_message = "canonical_edge_certificate_packs must cover both the managed-agent and hosted-site wildcard for this environment"
  }
}

variable "staging_agent_wildcard_origins" {
  description = "The exact existing IPv4 origins behind proxied *.staging.elizacloud.ai. This preserves the imported legacy records."
  type        = set(string)
  default     = []

  validation {
    condition = var.environment != "staging" || (
      length(var.staging_agent_wildcard_origins) == 2 &&
      alltrue([
        for address in var.staging_agent_wildcard_origins :
        can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")
      ])
    )
    error_message = "staging_agent_wildcard_origins must contain exactly the two existing IPv4 addresses for staging"
  }
}

variable "staging_agent_certificate_pack_id" {
  description = "Full id of the live advanced certificate pack covering *.staging.elizacloud.ai."
  type        = string
  default     = ""

  validation {
    condition = var.environment != "staging" || can(regex(
      "^[0-9a-f-]{8,}$",
      var.staging_agent_certificate_pack_id,
    ))
    error_message = "staging_agent_certificate_pack_id is required for staging so the live paid pack is imported instead of duplicated"
  }
}

variable "staging_agent_certificate_hosts" {
  description = "Exact, immutable host inventory on the live staging agent advanced certificate pack."
  type        = set(string)
  default     = []

  validation {
    condition = var.environment != "staging" || contains(
      var.staging_agent_certificate_hosts,
      "*.staging.elizacloud.ai",
    )
    error_message = "staging_agent_certificate_hosts must include *.staging.elizacloud.ai for staging"
  }
}

variable "legacy_redirect_wildcard_origins" {
  description = "Reviewed IPv4 origin inventory for deeper legacy wildcard names that will enter Worker redirect routes."
  type        = map(set(string))
  default     = {}

  validation {
    condition = alltrue([
      for origins in values(var.legacy_redirect_wildcard_origins) :
      length(origins) > 0 && alltrue([
        for address in origins :
        can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")
      ])
    ])
    error_message = "every legacy redirect wildcard must have at least one reviewed IPv4 origin"
  }

  validation {
    condition = length(setsubtract(
      var.environment == "production" ? toset([
        "*.elizacloud.ai",
        "*.sites.elizacloud.ai",
        "*.tunnel.elizacloud.ai",
        ]) : toset([
        "*.sites-staging.elizacloud.ai",
        "*.tunnel-staging.elizacloud.ai",
      ]),
      toset(keys(var.legacy_redirect_wildcard_origins)),
      )) == 0 && length(setsubtract(
      toset(keys(var.legacy_redirect_wildcard_origins)),
      var.environment == "production" ? toset([
        "*.elizacloud.ai",
        "*.sites.elizacloud.ai",
        "*.tunnel.elizacloud.ai",
        ]) : toset([
        "*.sites-staging.elizacloud.ai",
        "*.tunnel-staging.elizacloud.ai",
      ]),
    )) == 0
    error_message = "legacy_redirect_wildcard_origins must contain exactly the legacy Worker redirect wildcard inventory for this environment"
  }
}

variable "legacy_redirect_certificate_packs" {
  description = "Additive advanced-certificate generations for deep legacy redirect wildcards. Set id to import an existing generation; add a new map key for expanded coverage."
  type = map(object({
    id    = optional(string, "")
    hosts = set(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for pack in values(var.legacy_redirect_certificate_packs) :
      (pack.id == "" || can(regex("^[0-9a-f-]{8,}$", pack.id))) &&
      contains(pack.hosts, "elizacloud.ai")
    ])
    error_message = "every legacy redirect certificate generation must include elizacloud.ai and any import id must be a Cloudflare certificate pack id"
  }

  validation {
    condition = alltrue([
      for required_host in(
        var.environment == "production" ?
        ["*.sites.elizacloud.ai", "*.tunnel.elizacloud.ai"] :
        ["*.sites-staging.elizacloud.ai", "*.tunnel-staging.elizacloud.ai"]
        ) : contains(flatten([
          for pack in values(var.legacy_redirect_certificate_packs) : tolist(pack.hosts)
      ]), required_host)
    ])
    error_message = "legacy_redirect_certificate_packs must cover every deep legacy redirect wildcard for this environment"
  }
}
