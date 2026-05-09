# Main Terraform Configuration for Gateway Discord Infrastructure
# This creates all the AWS infrastructure needed for the Discord gateway service

locals {
  cluster_name = var.cluster_name != "" ? var.cluster_name : "gateway-cluster-${var.environment == "production" ? "prod" : "dev"}"
}

# VPC Module
module "vpc" {
  source = "./modules/vpc"

  vpc_cidr             = var.vpc_cidr
  cluster_name         = local.cluster_name
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs

  # NAT Configuration - use NAT Instance for development (cost savings)
  use_nat_instance   = var.use_nat_instance
  nat_instance_type  = var.nat_instance_type
  single_nat_gateway = var.single_nat_gateway
  # Note: nat_instance_key_name intentionally not passed - SSM-only access is preferred
  # for security (no SSH keys needed). NAT instance has SSM agent enabled via IAM role.
  # To enable SSH access, add nat_instance_key_name variable to root module and pass here.
}

# EKS Module - Using official terraform-aws-modules/eks/aws v21.x
# https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = local.cluster_name
  kubernetes_version = var.kubernetes_version

  # VPC Configuration
  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnet_ids
  control_plane_subnet_ids = concat(module.vpc.private_subnet_ids, module.vpc.public_subnet_ids)

  # Cluster Endpoint Access
  endpoint_public_access       = var.cluster_endpoint_public_access
  endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
  endpoint_private_access      = var.cluster_endpoint_private_access

  # Authentication - API and ConfigMap mode for flexibility
  authentication_mode                      = "API_AND_CONFIG_MAP"
  enable_cluster_creator_admin_permissions = true

  # KMS encryption for secrets
  create_kms_key                  = true
  kms_key_aliases                 = ["alias/${local.cluster_name}-eks"]
  kms_key_deletion_window_in_days = 7
  enable_kms_key_rotation         = true

  encryption_config = {
    resources = ["secrets"]
  }

  # CloudWatch logging
  enabled_log_types                      = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = 30

  # OIDC provider for IRSA (IAM Roles for Service Accounts)
  enable_irsa = true

  # EKS Addons
  # IMPORTANT: before_compute = true ensures VPC CNI is created BEFORE node groups
  # Without this, nodes start without networking and fail health checks
  addons = {
    vpc-cni = {
      before_compute              = true
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
    }
    coredns = {
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
    }
    kube-proxy = {
      most_recent                 = true
      resolve_conflicts_on_create = "OVERWRITE"
      resolve_conflicts_on_update = "OVERWRITE"
    }
  }

  # EKS Access Entries for cluster administrators
  access_entries = {
    for idx, arn in var.cluster_admin_arns : "admin-${idx}" => {
      principal_arn = arn
      type          = "STANDARD"
      policy_associations = {
        admin = {
          policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }
  }

  # Managed Node Group
  # Note: Using short name to avoid AWS name_prefix length limit (38 chars)
  # The module adds "-eks-node-group-" suffix to launch template name_prefix
  eks_managed_node_groups = {
    main = {
      name = "main"

      instance_types = var.node_group_instance_types
      capacity_type  = var.node_group_capacity_type
      disk_size      = var.node_group_disk_size

      min_size     = var.node_group_min_size
      max_size     = var.node_group_max_size
      desired_size = var.node_group_desired_size

      labels = {
        role        = "gateway-discord"
        environment = var.environment
      }

      update_config = {
        max_unavailable = 1
      }
    }
  }

  # Security Group Rules - Allow VPC CIDR for NAT instance return traffic
  node_security_group_additional_rules = {
    ingress_from_vpc = {
      description = "Allow all traffic from VPC for NAT instance return traffic"
      protocol    = "-1"
      from_port   = 0
      to_port     = 0
      type        = "ingress"
      cidr_blocks = [var.vpc_cidr]
    }
  }

  tags = {
    Name        = local.cluster_name
    Environment = var.environment
  }
}

# EKS Blueprints Addons - Cluster-wide addons (Prometheus, metrics-server)
# https://registry.terraform.io/modules/aws-ia/eks-blueprints-addons/aws/latest
module "eks_blueprints_addons" {
  source  = "aws-ia/eks-blueprints-addons/aws"
  version = "~> 1.23"

  cluster_name      = module.eks.cluster_name
  cluster_endpoint  = module.eks.cluster_endpoint
  cluster_version   = module.eks.cluster_version
  oidc_provider_arn = module.eks.oidc_provider_arn

  # Prometheus monitoring stack -- only in production
  enable_kube_prometheus_stack = var.enable_prometheus
  kube_prometheus_stack = {
    namespace = "monitoring"
    set = [
      { name = "grafana.enabled", value = "false" },
    ]
  }

  # Metrics server -- needed for HPA in all environments
  enable_metrics_server = true

  # Disable CloudFormation telemetry stack (avoids needing cloudformation:CreateStack permission)
  observability_tag = null

  tags = {
    Environment = var.environment
  }

  depends_on = [module.eks]
}

# Data source to look up existing GitHub OIDC provider (when not creating one)
data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

# GitHub OIDC Module - Using official terraform-module/github-oidc-provider/aws
# https://registry.terraform.io/modules/terraform-module/github-oidc-provider/aws/latest
module "github_oidc" {
  source  = "terraform-module/github-oidc-provider/aws"
  version = "~> 2.2"

  create_oidc_provider = var.create_oidc_provider
  create_oidc_role     = var.create_github_actions_role

  # Required when create_oidc_provider = false
  oidc_provider_arn = var.create_oidc_provider ? null : data.aws_iam_openid_connect_provider.github[0].arn

  role_name        = local.github_actions_role_name
  role_description = "IAM role for GitHub Actions to deploy gateway-discord to EKS"

  # Repository access patterns - allows main, develop branches, PRs, and environments
  # Note: Wildcard patterns (e.g., feat/*) are not supported by module validation
  # For feature branches, use the repo-level access which allows all refs
  repositories = [
    "${var.github_org}/${var.github_repo}"
  ]

  # Attach managed policies (inline policies added separately below)
  oidc_role_attach_policies = []

  # Increase session duration for longer deployments
  max_session_duration = 3600

  tags = {
    Name        = local.github_actions_role_name
    Environment = var.environment
  }
}

# Data sources for IAM policy scoping
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Locals for GitHub Actions role
locals {
  github_actions_env_suffix = var.environment == "production" ? "prd" : "dev"
  github_actions_role_name  = "github-actions-gateway-${local.github_actions_env_suffix}"
  account_id                = data.aws_caller_identity.current.account_id
  region                    = data.aws_region.current.id

  # aws-auth ConfigMap data for Kubernetes access
  aws_auth_configmap_data = {
    mapRoles = yamlencode([
      {
        rolearn  = module.github_oidc.oidc_role
        username = "github-actions"
        groups   = ["github-actions-deployers"]
      }
    ])
  }
}

# IAM Policy for EKS access - scoped to specific cluster
resource "aws_iam_role_policy" "github_actions_eks" {
  count = var.create_github_actions_role ? 1 : 0

  name = "${local.github_actions_role_name}-eks-policy"
  role = local.github_actions_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters"
        ]
        Resource = "arn:aws:eks:${local.region}:${local.account_id}:cluster/${local.cluster_name}"
      }
    ]
  })

  depends_on = [module.github_oidc]
}

# IAM Policy for ECR access - scoped to gateway-discord repositories
resource "aws_iam_role_policy" "github_actions_ecr" {
  count = var.create_github_actions_role ? 1 : 0

  name = "${local.github_actions_role_name}-ecr-policy"
  role = local.github_actions_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECRGetAuthToken"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Sid    = "ECRRepositoryAccess"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = "arn:aws:ecr:${local.region}:${local.account_id}:repository/gateway-discord*"
      }
    ]
  })

  depends_on = [module.github_oidc]
}

# Kubernetes Resources Module
# Note: This module requires the EKS cluster to be ready
# Run with: terraform apply -target=module.vpc -target=module.eks first
# Then: terraform apply to create K8s resources
module "k8s_resources" {
  source = "./modules/k8s-resources"

  namespace                        = "gateway-discord"
  environment                      = var.environment
  ghcr_username                    = var.ghcr_username
  ghcr_token                       = var.ghcr_token
  eliza_cloud_url                  = var.eliza_cloud_url
  gateway_bootstrap_secret         = var.gateway_bootstrap_secret
  redis_url                        = var.redis_url
  redis_token                      = var.redis_token
  blob_token                       = var.blob_token
  eliza_app_discord_bot_token      = var.eliza_app_discord_bot_token
  eliza_app_discord_application_id = var.eliza_app_discord_application_id
  enable_aws_auth_update           = var.enable_aws_auth_update
  node_group_role_arn              = module.eks.eks_managed_node_groups["main"].iam_role_arn
  github_actions_role_arn          = module.github_oidc.oidc_role
  existing_aws_auth_roles          = var.existing_aws_auth_roles

  depends_on = [module.eks]
}
