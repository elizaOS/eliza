variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'"
  }
}

# ── Shared apps-project credentials ──────────────────────────────────────────
# The apps data-plane lives in a SINGLE SHARED Hetzner Cloud Project (one
# quota, one set of SSH keys, one private network) — NOT split per environment
# like the control-plane is. The per-env scoping stays in the Terraform state
# file key + resource names (eliza-apps-node-${env}-N, eliza-apps-tenantdb-
# ${env}); both staging and production apply rounds land in the same Hetzner
# project.
#
# The provider picks up the token from this variable OR the HCLOUD_TOKEN env
# var. GitHub Actions wires the REPO-LEVEL secret HCLOUD_APPS_TOKEN as
# HCLOUD_TOKEN for both staging and production runs.
# See ARCHITECTURE.md § "Multi-project layout" for the topology.
variable "hcloud_token" {
  description = "Hetzner Cloud API token for the shared apps Hetzner project. Leave null to pick up from HCLOUD_TOKEN env var (the GHA pattern, sourced from repo-level secret HCLOUD_APPS_TOKEN)."
  type        = string
  default     = null
  sensitive   = true
}

variable "hcloud_location" {
  description = "Hetzner Cloud datacenter location. MUST match the control-plane + agent data plane (fsn1) so the private network and DB latency stay sane."
  type        = string
  default     = "fsn1"
}

variable "hcloud_image" {
  description = "Base image for the apps data-plane VMs."
  type        = string
  default     = "ubuntu-24.04"
}

# ── App worker node(s): Docker hosts for UNTRUSTED user images ───────────────
variable "app_node_server_type" {
  description = "Hetzner server type for an app worker node (runs untrusted user containers). ccx23 = 4 dedicated vCPU / 16 GB — dedicated vCPU suits untrusted multi-tenant workloads (no noisy-neighbor) and is orderable in fsn1 (cpx41 was retired there). Size to expected concurrent app density."
  type        = string
  default     = "ccx23"
}

variable "app_node_count" {
  description = "Number of app worker nodes. Start with 1 (allowlist beta); the runtime node-selector + autoscaler can grow this. Kept SEPARATE from agent nodes by design (untrusted vs trusted)."
  type        = number
  default     = 1
  validation {
    condition     = var.app_node_count >= 1 && var.app_node_count <= 20
    error_message = "app_node_count must be between 1 and 20"
  }
}

# ── Tenant Postgres cluster node: thousands of DATABASE+ROLE per node ─────────
variable "tenant_db_server_type" {
  description = "Hetzner server type for the tenant Postgres node. ccx33 (dedicated 8 vCPU / 32 GB) is a sane start for thousands of small tenant DBs; scale up or add nodes (shards) as database_count grows."
  type        = string
  default     = "ccx33"
}

variable "tenant_db_volume_size_gb" {
  description = "Size of the attached block-storage volume that holds all tenant databases (PGDATA lives here so the node can be rebuilt without data loss)."
  type        = number
  default     = 200
}

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log in as root. Provide via tfvars; never commit private keys."
  type        = list(string)
  default     = []
}

variable "network_cidr" {
  description = "Private network CIDR for the apps data plane. MUST NOT overlap the agent data-plane network — apps and agents are isolated."
  type        = string
  default     = "10.30.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet within network_cidr where the app nodes + tenant DB attach."
  type        = string
  default     = "10.30.1.0/24"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone for elizacloud.ai — used for the per-app ingress wildcard / node DNS."
  type        = string
}

variable "apps_base_domain" {
  description = "Base domain apps are served under (CONTAINERS_PUBLIC_BASE_DOMAIN). Each app gets <shortid>.<base>. MUST be distinct per environment to avoid Cloudflare DNS collisions when both envs share the same zone — staging should be e.g. apps-staging.elizacloud.ai, prod e.g. apps.elizacloud.ai. No default: forces the workflow to supply it explicitly."
  type        = string
  validation {
    condition     = length(var.apps_base_domain) > 0 && !can(regex("\\s", var.apps_base_domain))
    error_message = "apps_base_domain must be a non-empty hostname (no whitespace)"
  }
  validation {
    condition     = var.environment != "staging" || endswith(var.apps_base_domain, "-staging.elizacloud.ai") || startswith(var.apps_base_domain, "apps-staging.")
    error_message = "staging apps_base_domain must end in '-staging.elizacloud.ai' (e.g. apps-staging.elizacloud.ai) to keep prod and staging DNS records distinct"
  }
}

variable "operator_ingress_cidrs" {
  description = "CIDRs allowed to SSH the nodes (operator IPs / control-plane). No default: the workflow MUST supply a tight list — '0.0.0.0/0' is explicitly rejected by the validation below to fail closed on every apply."
  type        = list(string)
  validation {
    condition     = length(var.operator_ingress_cidrs) > 0 && alltrue([for c in var.operator_ingress_cidrs : c != "0.0.0.0/0" && c != "::/0"])
    error_message = "operator_ingress_cidrs MUST be a non-empty list of tight CIDRs (no 0.0.0.0/0 or ::/0); pin to operator IPs or the control-plane IP"
  }
}
