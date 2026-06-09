variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'"
  }
}

# ── Multi-project credentials ────────────────────────────────────────────────
# Each environment has its own Hetzner Cloud Project (= its own 5-server quota,
# its own SSH keys, its own private network). The provider picks up the token
# from this variable OR the HCLOUD_TOKEN env var. GitHub Actions wires the
# right project's token via the environment-scoped secret HCLOUD_TOKEN.
# See ../ARCHITECTURE.md § "Multi-project layout" for the pattern.
variable "hcloud_token" {
  description = "Hetzner Cloud API token for the project that owns THIS environment's resources. Leave null to pick up from HCLOUD_TOKEN env var (the GHA pattern)."
  type        = string
  default     = null
  sensitive   = true
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
  description = "DNS subdomain prefix. Final record: <prefix>-<environment>-<n>.elizacloud.ai (e.g. eliza-production-1.elizacloud.ai)"
  type        = string
  default     = "eliza"
}

variable "deploy_branch" {
  description = "Git branch the host's auto-deploy workflow follows. Staging defaults to 'develop'; production MUST be 'main' (enforced by the validation below) so a staging fix doesn't accidentally land in prod via the wrong branch pin."
  type        = string
  default     = "develop"
  validation {
    condition     = var.environment != "production" || var.deploy_branch == "main"
    error_message = "deploy_branch must be 'main' when environment='production' — set it explicitly via the workflow to prevent prod tracking develop"
  }
}

variable "operator_ingress_cidrs" {
  description = "CIDRs allowed to SSH the control-plane VM. No default: the workflow MUST supply a tight list — '0.0.0.0/0' is explicitly rejected by the validation below to fail closed on every apply. The control-plane has no firewall today (port 22 is open to the world); this variable feeds the new hcloud_firewall.control_plane resource that closes that gap."
  type        = list(string)
  validation {
    condition     = length(var.operator_ingress_cidrs) > 0 && alltrue([for c in var.operator_ingress_cidrs : c != "0.0.0.0/0" && c != "::/0"])
    error_message = "operator_ingress_cidrs MUST be a non-empty list of tight CIDRs (no 0.0.0.0/0 or ::/0); pin to operator IPs"
  }
}
