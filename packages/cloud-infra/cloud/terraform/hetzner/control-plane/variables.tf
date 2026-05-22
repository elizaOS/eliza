variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'"
  }
}

variable "hcloud_location" {
  description = "Hetzner Cloud datacenter location (must match data-plane). Existing fleet runs in fsn1."
  type        = string
  default     = "fsn1"
}

variable "hcloud_server_type" {
  description = "Hetzner server type for the control-plane VM. cpx21 = 3 vCPU / 4 GB / 80 GB SSD ≈ €5/mo, enough for daemon + agent-router + headscale + monitoring."
  type        = string
  default     = "cpx21"
}

variable "hcloud_image" {
  description = "Base image for the control-plane VM."
  type        = string
  default     = "ubuntu-24.04"
}

variable "control_plane_count" {
  description = "Number of control-plane VMs. Start with 1; bump to 2 once headscale/HA is wired."
  type        = number
  default     = 1
  validation {
    condition     = var.control_plane_count >= 1 && var.control_plane_count <= 3
    error_message = "control_plane_count must be between 1 and 3"
  }
}

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log into the VM as root. Provide via tfvars; never commit."
  type        = list(string)
  default     = []
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone for the elizacloud.ai domain — used to point control-plane DNS at the VM."
  type        = string
}

variable "control_plane_hostname_prefix" {
  description = "DNS subdomain prefix. Final record: <prefix>-<environment>-<n>.elizacloud.ai"
  type        = string
  default     = "cp"
}

variable "deploy_branch" {
  description = "Git branch the host's auto-deploy workflow follows."
  type        = string
  default     = "develop"
}
