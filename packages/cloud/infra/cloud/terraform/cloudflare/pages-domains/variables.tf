variable "environment" {
  description = "Cloudflare Pages environment whose domain bindings this state owns."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the eliza-cloud and eliza-app Pages projects."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal Cloudflare account id"
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for elizacloud.ai."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character hexadecimal Cloudflare zone id"
  }
}

variable "staging_agent_wildcard_origins" {
  description = "The two existing IPv4 origins behind the proxied *.staging.elizacloud.ai records. Set from the staging GitHub Environment inventory."
  type        = set(string)
  default     = []

  validation {
    condition = var.environment != "staging" || (
      length(var.staging_agent_wildcard_origins) == 2 &&
      alltrue([for address in var.staging_agent_wildcard_origins : can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")])
    )
    error_message = "staging_agent_wildcard_origins must contain exactly two IPv4 addresses for staging"
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
  description = "Exact host inventory on the live staging agent advanced certificate pack."
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
