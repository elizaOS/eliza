variable "environment" {
  description = "Deployment environment (development, staging, production)"
  type        = string
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be 'development', 'staging', or 'production'"
  }
}

# Use a project token scoped to this environment's apps infrastructure.
# Worker and database roots share that project's network within one tier only.
variable "hcloud_token" {
  description = "Hetzner token for this environment apps project; null uses HCLOUD_TOKEN."
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
    # Bound this operator-managed pool; runtime capacity has its own admission.
    condition     = var.app_node_count >= 1 && var.app_node_count <= 9
    error_message = "app_node_count must be an integer between 1 and 9"
  }
}

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log in as root. Provide via tfvars; never commit private keys."
  type        = list(string)
  default     = []
}

variable "cloudflare_zone_id" {
  description = "Legacy Cloudflare zone for elizacloud.ai — retained so old app hosts can redirect at the Worker edge."
  type        = string
}

variable "eliza_app_zone_id" {
  description = "Canonical Cloudflare zone for eliza.app — used for per-app ingress."
  type        = string
}

variable "legacy_apps_base_domain" {
  description = "Legacy per-app base domain kept as proxied redirect ingress during migration."
  type        = string
  validation {
    condition     = var.legacy_apps_base_domain == (var.environment == "production" ? "apps.elizacloud.ai" : "apps-${var.environment}.elizacloud.ai")
    error_message = "legacy_apps_base_domain must belong to the selected environment"
  }
}

variable "apps_base_domain" {
  description = "Base domain apps are served under (CONTAINERS_PUBLIC_BASE_DOMAIN). Each app gets <shortid>.<base>. Staging uses apps-staging.eliza.app and production uses apps.eliza.app."
  type        = string
  validation {
    condition     = length(var.apps_base_domain) > 0 && !can(regex("\\s", var.apps_base_domain))
    error_message = "apps_base_domain must be a non-empty hostname (no whitespace)"
  }
  validation {
    condition     = var.apps_base_domain == (var.environment == "production" ? "apps.eliza.app" : "apps-${var.environment}.eliza.app")
    error_message = "apps_base_domain must belong to the selected environment"
  }
}

variable "cloud_api_origin" {
  description = "Origin of THIS environment's cloud-api Worker (https://api-staging.eliza.app staging, https://api.eliza.app prod). Caddy's on-demand-TLS ask endpoint lives under it."
  type        = string
  validation {
    condition     = can(regex("^https://[^/\\s]+$", var.cloud_api_origin))
    error_message = "cloud_api_origin must be an https:// origin with no trailing slash or path (e.g. https://api-staging.eliza.app)"
  }
  validation {
    condition     = var.cloud_api_origin == (var.environment == "production" ? "https://api.eliza.app" : "https://api-${var.environment}.eliza.app")
    error_message = "cloud_api_origin must belong to the selected environment"
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
