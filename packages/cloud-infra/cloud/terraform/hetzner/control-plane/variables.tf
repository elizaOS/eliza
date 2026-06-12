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
  description = "Hetzner server type for the control-plane VM. cpx32 = 4 vCPU / 8 GB / 160 GB SSD ≈ €11/mo, matches the existing staging eliza-staging-1 manually-provisioned VM. Previously cpx21 (3 vCPU / 4 GB) but Hetzner retired cpx21 in fsn1. Production runs cax21 (ARM) — switching staging to ARM would save ~€4/mo and unblock future cpx retirement, but needs a few cloud-init template tweaks (docker apt arch + bun-linux-aarch64 archive). Staging stays on x86 cpx32 here for parity with the proven-working setup; ARM migration is followup."
  type        = string
  default     = "cpx32"
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

# ── Data-plane private network (autoscaled workers + CP share this LAN) ──────
variable "data_plane_network_cidr" {
  description = "Private network CIDR for the data plane in THIS environment's Hetzner project. Each environment owns its own Hetzner project, so identical CIDRs across envs don't conflict — keeping them aligned avoids per-env static IP surprises when the autoscaler computes worker IPs."
  type        = string
  default     = "10.42.0.0/16"
}

variable "data_plane_subnet_cidr" {
  description = "Subnet within data_plane_network_cidr where workers + CP attach."
  type        = string
  default     = "10.42.0.0/24"
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
