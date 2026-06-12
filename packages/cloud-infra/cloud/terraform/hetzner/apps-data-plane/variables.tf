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
# quota, one set of SSH keys, one private network). The shared network +
# tenant Postgres node are owned by ../apps-shared/. This module is per-env
# (one tfstate per env) and only manages app worker nodes + the wildcard
# Cloudflare record.
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
  description = "Hetzner Cloud datacenter location. MUST match the apps-shared module so app nodes can attach to its private network."
  type        = string
  default     = "fsn1"
}

variable "hcloud_image" {
  description = "Base image for the app worker node VMs."
  type        = string
  default     = "ubuntu-24.04"
}

# ── App worker node(s): Docker hosts for UNTRUSTED user images ───────────────
variable "app_node_server_type" {
  description = "Hetzner server type for an app worker node (runs untrusted user containers). ccx23 = 4 dedicated vCPU / 16 GB — dedicated vCPU is required because tenants run untrusted code: no CPU steal from noisy neighbors, mitigates host side-channel risk. Size to expected concurrent app density."
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

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log in as root. Provide via tfvars; never commit private keys."
  type        = list(string)
  default     = []
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
  description = "CIDRs allowed to SSH the app worker nodes (operator IPs / control-plane). No default: the workflow MUST supply a tight list — '0.0.0.0/0' is explicitly rejected by the validation below to fail closed on every apply."
  type        = list(string)
  validation {
    condition     = length(var.operator_ingress_cidrs) > 0 && alltrue([for c in var.operator_ingress_cidrs : c != "0.0.0.0/0" && c != "::/0"])
    error_message = "operator_ingress_cidrs MUST be a non-empty list of tight CIDRs (no 0.0.0.0/0 or ::/0); pin to operator IPs or the control-plane IP"
  }
}
