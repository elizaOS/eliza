variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'"
  }
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
  description = "Hetzner server type for an app worker node (runs untrusted user containers). cpx41 = 8 vCPU / 16 GB; size to expected concurrent app density."
  type        = string
  default     = "cpx41"
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
  description = "Base domain apps are served under (CONTAINERS_PUBLIC_BASE_DOMAIN). Each app gets <shortid>.<base>. e.g. apps.elizacloud.ai"
  type        = string
  default     = "apps.elizacloud.ai"
}

variable "operator_ingress_cidrs" {
  description = "CIDRs allowed to SSH the nodes (operator IPs / control-plane). Defaults to 'anywhere' for the DRAFT — Stan MUST tighten this before production."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
