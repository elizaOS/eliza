# VPC Outputs
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = module.vpc.vpc_cidr
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = module.vpc.public_subnet_ids
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = module.vpc.private_subnet_ids
}

# EKS Outputs (using official terraform-aws-modules/eks/aws module)
output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_arn" {
  description = "EKS cluster ARN"
  value       = module.eks.cluster_arn
}

output "cluster_certificate_authority_data" {
  description = "Base64 encoded certificate data for cluster"
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "cluster_security_group_id" {
  description = "Security group ID for the cluster (EKS-managed primary security group)"
  value       = module.eks.cluster_primary_security_group_id
}

output "node_security_group_id" {
  description = "Security group ID for the nodes"
  value       = module.eks.node_security_group_id
}

output "oidc_provider_arn" {
  description = "OIDC provider ARN for IRSA"
  value       = module.eks.oidc_provider_arn
}

output "node_group_role_arn" {
  description = "IAM role ARN for the node group (used by aws-auth ConfigMap)"
  value       = module.eks.eks_managed_node_groups["main"].iam_role_arn
}

# GitHub OIDC Outputs (using official terraform-module/github-oidc-provider/aws module)
output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions (use as GATEWAY_AWS_ROLE_ARN)"
  value       = module.github_oidc.oidc_role
}

output "github_oidc_provider_arn" {
  description = "GitHub OIDC provider ARN"
  value       = module.github_oidc.oidc_provider_arn
}

# Kubernetes Outputs
output "namespace" {
  description = "Kubernetes namespace for gateway-discord"
  value       = module.k8s_resources.namespace
}

# Kubeconfig command
output "kubeconfig_command" {
  description = "Command to configure kubectl"
  value       = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.aws_region}"
}

# GitHub Actions Variables
output "github_actions_variables" {
  description = "Variables to set in GitHub repository for deployment"
  value = {
    GATEWAY_AWS_ROLE_ARN = module.github_oidc.oidc_role
    AWS_REGION           = var.aws_region
    CLUSTER_NAME         = module.eks.cluster_name
  }
}
