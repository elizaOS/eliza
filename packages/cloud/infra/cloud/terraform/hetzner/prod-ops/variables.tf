variable "hcloud_token" {
  description = "Hetzner Cloud token for the existing production project. Leave null to use HCLOUD_TOKEN."
  type        = string
  default     = null
  sensitive   = true
}

variable "environment" {
  description = "Protected environment. The prod-ops runner exists only in production."
  type        = string

  validation {
    condition     = var.environment == "production"
    error_message = "prod-ops must be applied only through the production environment"
  }
}

variable "hcloud_location" {
  description = "Hetzner location for the dedicated runner VM."
  type        = string
  default     = "ash"
}

variable "hcloud_server_type" {
  description = "Small x86 VM for trusted deployment and cutover jobs; resize only after measuring the protected lane."
  type        = string
  default     = "cpx22"
}

variable "hcloud_image" {
  description = "Pinned operating-system family for the runner host."
  type        = string
  default     = "ubuntu-24.04"
}

variable "runner_count" {
  description = "Number of independent one-job runner slots reserved for protected operations."
  type        = number
  default     = 2

  validation {
    condition     = var.runner_count >= 2 && var.runner_count <= 4 && floor(var.runner_count) == var.runner_count
    error_message = "runner_count must be an integer from 2 through 4"
  }
}

variable "ssh_public_keys" {
  description = "Core-admin SSH public keys installed for the runner-admin account."
  type        = list(string)

  validation {
    condition     = length(var.ssh_public_keys) > 0 && alltrue([for key in var.ssh_public_keys : startswith(key, "ssh-")])
    error_message = "ssh_public_keys must contain at least one OpenSSH public key"
  }
}

variable "operator_ingress_cidrs" {
  description = "Tight core-admin CIDRs allowed to reach SSH; public ingress is forbidden."
  type        = list(string)

  validation {
    condition = (
      length(var.operator_ingress_cidrs) > 0 &&
      alltrue([for cidr in var.operator_ingress_cidrs : cidr != "0.0.0.0/0" && cidr != "::/0"])
    )
    error_message = "operator_ingress_cidrs must be non-empty and may not contain a world-open CIDR"
  }
}
