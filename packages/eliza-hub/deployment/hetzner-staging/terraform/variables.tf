variable "environment" {
  description = "Deployment environment label."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "server_name" {
  description = "RFC 1123 hostname for the dedicated Eliza Hub server."
  type        = string
  default     = "eliza-hub-staging-1"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.server_name))
    error_message = "server_name must be a valid lowercase RFC 1123 hostname."
  }
}

variable "server_type" {
  description = "Hetzner server type. CPX32 is the supported pilot baseline."
  type        = string
  default     = "cpx32"
}

variable "server_image" {
  description = "Hetzner system image used for first boot."
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner location for the server and static IPv4 address."
  type        = string
  default     = "hel1"
}

variable "operator_user" {
  description = "Non-root host operator created by cloud-init."
  type        = string
  default     = "eliza"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{1,30}$", var.operator_user))
    error_message = "operator_user must be a stable Linux username."
  }
}

variable "operator_ssh_public_keys" {
  description = "Map of Hetzner SSH key names to OpenSSH public keys. At least one operator key is required."
  type        = map(string)

  validation {
    condition = length(var.operator_ssh_public_keys) > 0 && alltrue([
      for name, key in var.operator_ssh_public_keys :
      can(regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$", name)) &&
      can(regex("^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\\.com) ", trimspace(key)))
    ])
    error_message = "operator_ssh_public_keys must contain named OpenSSH public keys."
  }
}

variable "operator_ssh_cidrs" {
  description = "CIDRs allowed to administer the host over SSH. Use narrow /32 or /128 entries where possible."
  type        = list(string)

  validation {
    condition = length(var.operator_ssh_cidrs) > 0 && alltrue([
      for cidr in var.operator_ssh_cidrs : can(cidrhost(cidr, 0))
    ])
    error_message = "operator_ssh_cidrs must contain at least one valid IPv4 or IPv6 CIDR."
  }
}

variable "operator_ssh_port" {
  description = "Host administration SSH port."
  type        = number
  default     = 22

  validation {
    condition     = var.operator_ssh_port >= 1 && var.operator_ssh_port <= 65535
    error_message = "operator_ssh_port must be between 1 and 65535."
  }
}

variable "git_ssh_port" {
  description = "Public Forgejo SSH port. It must differ from the host administration SSH port."
  type        = number
  default     = 2222

  validation {
    condition     = var.git_ssh_port >= 1 && var.git_ssh_port <= 65535
    error_message = "git_ssh_port must be between 1 and 65535."
  }
}

variable "git_ssh_cidrs" {
  description = "CIDRs allowed to clone and push through Forgejo SSH."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    condition = length(var.git_ssh_cidrs) > 0 && alltrue([
      for cidr in var.git_ssh_cidrs : can(cidrhost(cidr, 0))
    ])
    error_message = "git_ssh_cidrs must contain valid IPv4 or IPv6 CIDRs."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone identifier. Keep account-specific IDs in the private tfvars file."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character hexadecimal zone identifier."
  }
}

variable "web_hostname" {
  description = "Canonical HTTPS hostname for Forgejo and Merge Steward."
  type        = string

  validation {
    condition = length(var.web_hostname) <= 253 && length(split(".", var.web_hostname)) >= 2 && alltrue([
      for label in split(".", var.web_hostname) :
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", label))
    ])
    error_message = "web_hostname must be a lowercase fully qualified hostname."
  }
}

variable "ssh_hostname" {
  description = "DNS-only hostname for native Forgejo SSH traffic."
  type        = string

  validation {
    condition = length(var.ssh_hostname) <= 253 && length(split(".", var.ssh_hostname)) >= 2 && alltrue([
      for label in split(".", var.ssh_hostname) :
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", label))
    ])
    error_message = "ssh_hostname must be a lowercase fully qualified hostname."
  }
}

variable "cloudflare_proxy_web" {
  description = "Proxy the web hostname through Cloudflare after direct TLS and Git/LFS/package upload limits are reviewed."
  type        = bool
  default     = false
}

variable "enable_hcloud_backups" {
  description = "Enable Hetzner server backups. Off-host application backups remain separately required."
  type        = bool
  default     = true
}

variable "enable_delete_protection" {
  description = "Protect the server and static IPv4 address from accidental deletion or rebuild."
  type        = bool
  default     = true
}

variable "extra_labels" {
  description = "Additional non-secret Hetzner labels."
  type        = map(string)
  default     = {}
}
