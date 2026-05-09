# Environment and naming
variable "environment" {
  description = "Environment name (development, production)"
  type        = string
  validation {
    condition     = contains(["development", "production"], var.environment)
    error_message = "Environment must be 'development' or 'production'"
  }
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "gateway-discord"
}

# AWS Configuration
variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

# VPC Configuration
variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
}

# NAT Configuration
variable "use_nat_instance" {
  description = "Use NAT Instance instead of NAT Gateway (cost saving for non-prod)"
  type        = bool
  default     = false
}

variable "nat_instance_type" {
  description = "Instance type for NAT instance (t4g.nano for development, t4g.micro for production)"
  type        = string
  default     = "t4g.nano"
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway/instance for all AZs (cost savings, less redundancy)"
  type        = bool
  default     = true
}

# EKS Configuration
variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version for EKS"
  type        = string
  default     = "1.34"
}

variable "cluster_endpoint_public_access" {
  description = "Whether to enable public access to the EKS API server"
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "List of CIDR blocks allowed to access the EKS API server. Restrict to trusted networks for security."
  type        = list(string)
  default     = ["203.0.113.0/24"]
  validation {
    condition = (
      var.allow_public_cluster_endpoint_anywhere ||
      !contains(var.cluster_endpoint_public_access_cidrs, "0.0.0.0/0")
    )
    error_message = "Open EKS API access (0.0.0.0/0) is blocked unless allow_public_cluster_endpoint_anywhere is explicitly enabled."
  }
}

variable "cluster_endpoint_private_access" {
  description = "Whether to enable private access to the EKS API server"
  type        = bool
  default     = true
}

# Node Group Configuration
variable "node_group_instance_types" {
  description = "Instance types for the node group"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_group_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 2
}

variable "node_group_min_size" {
  description = "Minimum number of nodes"
  type        = number
  default     = 1
}

variable "node_group_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 10
}

variable "node_group_disk_size" {
  description = "Disk size in GB for nodes"
  type        = number
  default     = 50
}

variable "node_group_capacity_type" {
  description = "Capacity type: ON_DEMAND or SPOT"
  type        = string
  default     = "ON_DEMAND"
}

variable "cluster_admin_arns" {
  description = "List of IAM principal ARNs to grant EKS cluster admin access (e.g., IAM users, roles)"
  type        = list(string)
  default     = []
}

variable "allow_public_cluster_endpoint_anywhere" {
  description = "Explicit escape hatch for temporary 0.0.0.0/0 EKS API access. Leave false for normal use."
  type        = bool
  default     = false
}

# GitHub OIDC Configuration
variable "github_org" {
  description = "GitHub organization name"
  type        = string
  default     = "elizaos"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "cloud"
}

variable "create_oidc_provider" {
  description = "Whether to create the GitHub OIDC provider (set to false if it already exists in the AWS account)"
  type        = bool
  default     = true
}

variable "create_github_actions_role" {
  description = "Whether to create the GitHub Actions IAM role (set to false if it already exists from a previous run)"
  type        = bool
  default     = true
}

# Monitoring
variable "enable_prometheus" {
  description = "Enable Prometheus monitoring stack (kube-prometheus-stack). Only needed in production."
  type        = bool
  default     = false
}

# Tags
variable "tags" {
  description = "Additional tags for all resources"
  type        = map(string)
  default     = {}
}
