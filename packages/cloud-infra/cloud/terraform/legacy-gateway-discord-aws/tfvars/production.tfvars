# Production Environment Configuration

environment  = "production"
cluster_name = "gateway-cluster-prod"
aws_region   = "us-east-1"

# VPC Configuration
vpc_cidr             = "10.1.0.0/16"
availability_zones   = ["us-east-1a", "us-east-1b", "us-east-1c"]
private_subnet_cidrs = ["10.1.1.0/24", "10.1.2.0/24", "10.1.3.0/24"]
public_subnet_cidrs  = ["10.1.101.0/24", "10.1.102.0/24", "10.1.103.0/24"]

# NAT Configuration - Use NAT Instance for production (cost-effective for low traffic)
# For Discord gateway workload, NAT Instance is sufficient
# Add CloudWatch alarm for instance health monitoring
use_nat_instance   = true
nat_instance_type  = "t4g.micro" # ~$6/month, sufficient for Discord websocket traffic
single_nat_gateway = true

# EKS Configuration
kubernetes_version              = "1.34"
cluster_endpoint_public_access  = true
cluster_endpoint_private_access = true

# EKS Cluster Admin Access
# IAM principals that get cluster admin access via EKS Access API
#
# Configure production access in an untracked tfvars file (for example secrets.tfvars).
# Do not commit live AWS account IDs or admin principals to this repository.
cluster_admin_arns = []

# EKS API Server Access Control
#
# SECURITY NOTE: Currently open for initial infrastructure setup and CI/CD testing.
# Before production launch, restrict to trusted networks:
#   - GitHub Actions IPs (fetch from https://api.github.com/meta -> actions)
#   - VPN/office IP ranges
#   - Bastion host IPs
#
# Example restricted configuration:
#   cluster_endpoint_public_access_cidrs = ["203.0.113.0/24", "198.51.100.0/24"]
#
# For maximum security, set cluster_endpoint_public_access = false
# and access the cluster only via VPN/bastion through private endpoint.
#
cluster_endpoint_public_access_cidrs = ["203.0.113.0/24"]

# Node Group Configuration - Cost-effective for I/O-bound workload (Discord websockets)
# Using t3 (x86) because Docker image currently only supports amd64
# Discord gateway is I/O bound, not CPU bound - burstable instances are ideal
# TODO: Build ARM64 images to use cheaper t4g instances
node_group_instance_types = ["t3.medium", "t3.large"] # 2-4 vCPU, 4-8GB RAM
node_group_desired_size   = 1                         # Set as 2 when User-Created Bots are publically
node_group_min_size       = 1                         # Set as 2 when User-Created Bots are publically
node_group_max_size       = 10
node_group_disk_size      = 30 # Reduced - mostly stateless workload
node_group_capacity_type  = "ON_DEMAND"

# GitHub Configuration
github_org           = "elizaOS"
github_repo          = "cloud"
create_oidc_provider = false # GitHub OIDC provider already exists in AWS account

# Monitoring
enable_prometheus = true

# aws-auth ConfigMap
enable_aws_auth_update = true

# Tags
tags = {
  Environment = "production"
  Project     = "gateway-discord"
  Team        = "elizaos"
}
