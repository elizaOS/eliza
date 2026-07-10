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
