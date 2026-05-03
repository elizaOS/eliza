# Sensitive Variables - These should be provided via environment variables or secrets manager

# GHCR Credentials
variable "ghcr_username" {
  description = "GitHub Container Registry username"
  type        = string
  sensitive   = true
}

variable "ghcr_token" {
  description = "GitHub Container Registry token (PAT with packages:read scope)"
  type        = string
  sensitive   = true
}

# Application Secrets
variable "eliza_cloud_url" {
  description = "Eliza Cloud URL"
  type        = string
  sensitive   = true
}

variable "gateway_bootstrap_secret" {
  description = "Gateway bootstrap secret for service authentication"
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis URL (Upstash or similar)"
  type        = string
  sensitive   = true
}

variable "redis_token" {
  description = "Redis authentication token"
  type        = string
  sensitive   = true
}

variable "blob_token" {
  description = "Blob storage token (Vercel Blob or similar)"
  type        = string
  sensitive   = true
  default     = ""
}

# Eliza App Discord Bot Secrets (optional - for hybrid bot mode)
variable "eliza_app_discord_bot_token" {
  description = "Discord bot token for the Eliza App system bot (DM-based interactions)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "eliza_app_discord_application_id" {
  description = "Discord application ID for the Eliza App system bot"
  type        = string
  sensitive   = true
  default     = ""
}

# aws-auth ConfigMap
variable "enable_aws_auth_update" {
  description = "Whether to update aws-auth ConfigMap for GitHub Actions access"
  type        = bool
  default     = true
}

variable "existing_aws_auth_roles" {
  description = "Existing IAM roles in aws-auth ConfigMap to preserve"
  type        = list(any)
  default     = []
}
