# ── Shared apps-project credentials ──────────────────────────────────────────
# The apps-shared module owns the resources that are SHARED across staging +
# production app nodes: the private network + the tenant Postgres node.
# Per-env app worker nodes live in apps-data-plane and consume this module's
# outputs via a `terraform_remote_state` data source.
#
# The provider picks up the token from this variable OR the HCLOUD_TOKEN env
# var. GitHub Actions wires the REPO-LEVEL secret HCLOUD_APPS_TOKEN as
# HCLOUD_TOKEN.
variable "hcloud_token" {
  description = "Hetzner Cloud API token for the shared apps Hetzner project. Leave null to pick up from HCLOUD_TOKEN env var (the GHA pattern, sourced from repo-level secret HCLOUD_APPS_TOKEN)."
  type        = string
  default     = null
  sensitive   = true
}

variable "hcloud_location" {
  description = "Hetzner Cloud datacenter location. MUST match the apps-data-plane location so app nodes can attach to the shared private network."
  type        = string
  default     = "fsn1"
}

variable "hcloud_image" {
  description = "Base image for the tenant DB VM."
  type        = string
  default     = "ubuntu-24.04"
}

# ── Tenant Postgres cluster node: thousands of DATABASE+ROLE per node ─────────
variable "tenant_db_server_type" {
  description = "Hetzner server type for the tenant Postgres node. cpx42 (8 shared vCPU / 16 GB AMD) — no dedicated-CPU quota required. Postgres runs server-side (no untrusted code execution on this VM), so shared CPU is fine for isolation; the boundary is hostssl + private-network firewall + per-tenant ROLE. For perf-sensitive workloads, override to ccx33 (dedicated 8 vCPU / 32 GB)."
  type        = string
  default     = "cpx42"
}

variable "tenant_db_volume_size_gb" {
  description = "Size of the attached block-storage volume that holds all tenant databases (PGDATA lives here so the node can be rebuilt without data loss)."
  type        = number
  default     = 200
}

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log in as `deploy` on the tenant DB node. Provide via tfvars; never commit private keys."
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

variable "operator_ingress_cidrs" {
  description = "CIDRs allowed to SSH the tenant DB node (operator IPs / control-plane). No default: the workflow MUST supply a tight list — '0.0.0.0/0' is explicitly rejected by the validation below to fail closed on every apply."
  type        = list(string)
  validation {
    condition     = length(var.operator_ingress_cidrs) > 0 && alltrue([for c in var.operator_ingress_cidrs : c != "0.0.0.0/0" && c != "::/0"])
    error_message = "operator_ingress_cidrs MUST be a non-empty list of tight CIDRs (no 0.0.0.0/0 or ::/0); pin to operator IPs or the control-plane IP"
  }
}
