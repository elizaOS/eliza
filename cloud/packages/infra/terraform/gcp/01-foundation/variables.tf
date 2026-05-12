variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-east1"
}

variable "environment" {
  description = "Environment name (development, production)"
  type        = string
  validation {
    condition     = contains(["development", "production"], var.environment)
    error_message = "Environment must be 'development' or 'production'"
  }
}

variable "cluster_name" {
  description = "Name of the GKE cluster"
  type        = string
}

# Network
variable "subnet_cidr" {
  description = "Primary CIDR for the subnet"
  type        = string
  default     = "10.0.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary CIDR for GKE pods"
  type        = string
  default     = "10.48.0.0/14"
}

variable "services_cidr" {
  description = "Secondary CIDR for GKE services"
  type        = string
  default     = "10.52.0.0/20"
}

variable "master_ipv4_cidr" {
  description = "CIDR block for the GKE master network (must be /28)"
  type        = string
  default     = "172.16.0.0/28"
}

variable "master_authorized_cidrs" {
  description = "CIDR blocks allowed to access the GKE API server"
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = [{
    cidr_block   = "0.0.0.0/0"
    display_name = "All"
  }]
}

# GitHub
variable "github_repos" {
  description = "GitHub repos allowed to deploy via WIF (e.g. [\"elizaOS/cloud\"])"
  type        = list(string)
  default     = ["elizaOS/cloud"]
}

variable "deletion_protection" {
  description = "Enable cluster deletion protection (true for production)"
  type        = bool
  default     = true
}
