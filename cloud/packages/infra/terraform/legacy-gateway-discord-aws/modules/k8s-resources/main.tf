# Kubernetes Resources Module for Gateway Discord

# Namespace
resource "kubernetes_namespace" "gateway_discord" {
  metadata {
    name = var.namespace

    labels = {
      name        = var.namespace
      environment = var.environment
      managed-by  = "terraform"
    }
  }
}

# GHCR Image Pull Secret
resource "kubernetes_secret" "ghcr_credentials" {
  metadata {
    name      = "ghcr-credentials"
    namespace = kubernetes_namespace.gateway_discord.metadata[0].name
  }

  type = "kubernetes.io/dockerconfigjson"

  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        (var.container_registry_url) = {
          auth = base64encode("${var.ghcr_username}:${var.ghcr_token}")
        }
      }
    })
  }
}

# =============================================================================
# RBAC for GitHub Actions CI/CD
# Follows principle of least privilege - only grants permissions needed for
# Helm deployments in the gateway-discord namespace
# =============================================================================

# ClusterRole for cluster-level read access (needed for kubectl get nodes, etc.)
resource "kubernetes_cluster_role" "github_actions_cluster_reader" {
  metadata {
    name = "github-actions-cluster-reader"
    labels = {
      managed-by = "terraform"
    }
  }

  # Allow reading cluster-level resources for deployment status checks
  rule {
    api_groups = [""]
    resources  = ["nodes", "namespaces"]
    verbs      = ["get", "list", "watch"]
  }

  # Allow reading cluster-scoped storage classes
  rule {
    api_groups = ["storage.k8s.io"]
    resources  = ["storageclasses"]
    verbs      = ["get", "list", "watch"]
  }
}

# ClusterRoleBinding for cluster-level read access
resource "kubernetes_cluster_role_binding" "github_actions_cluster_reader" {
  metadata {
    name = "github-actions-cluster-reader"
    labels = {
      managed-by = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role.github_actions_cluster_reader.metadata[0].name
  }

  subject {
    kind = "Group"
    name = "github-actions-deployers"
  }
}

# Role for namespace-level access (full control of gateway-discord namespace)
resource "kubernetes_role" "github_actions_deployer" {
  metadata {
    name      = "github-actions-deployer"
    namespace = kubernetes_namespace.gateway_discord.metadata[0].name
    labels = {
      managed-by = "terraform"
    }
  }

  # Core resources for deployments
  rule {
    api_groups = [""]
    resources  = ["pods", "pods/log", "pods/exec", "services", "endpoints", "configmaps", "secrets", "serviceaccounts", "persistentvolumeclaims"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Deployment resources
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Batch jobs (for Helm hooks)
  rule {
    api_groups = ["batch"]
    resources  = ["jobs", "cronjobs"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Networking
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingresses", "networkpolicies"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Autoscaling
  rule {
    api_groups = ["autoscaling"]
    resources  = ["horizontalpodautoscalers"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Policy
  rule {
    api_groups = ["policy"]
    resources  = ["poddisruptionbudgets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # RBAC within namespace (for service accounts)
  rule {
    api_groups = ["rbac.authorization.k8s.io"]
    resources  = ["roles", "rolebindings"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Prometheus Operator CRDs (for ServiceMonitor and PrometheusRule)
  rule {
    api_groups = ["monitoring.coreos.com"]
    resources  = ["servicemonitors", "prometheusrules", "podmonitors"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Events (read-only for debugging)
  rule {
    api_groups = [""]
    resources  = ["events"]
    verbs      = ["get", "list", "watch"]
  }
}

# RoleBinding for namespace-level access
resource "kubernetes_role_binding" "github_actions_deployer" {
  metadata {
    name      = "github-actions-deployer"
    namespace = kubernetes_namespace.gateway_discord.metadata[0].name
    labels = {
      managed-by = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.github_actions_deployer.metadata[0].name
  }

  subject {
    kind = "Group"
    name = "github-actions-deployers"
  }
}

# Application Secrets
resource "kubernetes_secret" "gateway_discord_secrets" {
  metadata {
    name      = "gateway-discord-secrets"
    namespace = kubernetes_namespace.gateway_discord.metadata[0].name

    labels = {
      app         = "gateway-discord"
      environment = var.environment
    }
  }

  data = {
    "eliza-cloud-url"                  = var.eliza_cloud_url
    "gateway-bootstrap-secret"         = var.gateway_bootstrap_secret
    "redis-url"                        = var.redis_url
    "redis-token"                      = var.redis_token
    "blob-token"                       = var.blob_token
    "eliza-app-discord-bot-token"      = var.eliza_app_discord_bot_token
    "eliza-app-discord-application-id" = var.eliza_app_discord_application_id
  }
}

# aws-auth ConfigMap update for EKS access
#
# This resource manages the aws-auth ConfigMap which controls IAM role to Kubernetes
# RBAC mappings. It includes:
# - Node group role: Required for worker nodes to join the cluster
# - GitHub Actions role: For CI/CD deployments with least-privilege RBAC
#
# The GitHub Actions role is mapped to the 'github-actions-deployers' group which
# has custom RBAC permissions defined above:
# - ClusterRole: Read-only access to nodes and namespaces (for kubectl status)
# - Role: Full access to gateway-discord namespace resources (for Helm deployments)
#
# This follows the principle of least privilege - GitHub Actions can only:
# - Deploy to the gateway-discord namespace
# - Read cluster-level resources for status checks
# - Cannot access secrets in other namespaces or perform cluster-admin operations
resource "kubernetes_config_map_v1_data" "aws_auth" {
  count = var.enable_aws_auth_update ? 1 : 0

  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }

  data = {
    mapRoles = yamlencode(concat(
      # Node group role - required for nodes to register with the cluster
      [
        {
          rolearn  = var.node_group_role_arn
          username = "system:node:{{EC2PrivateDNSName}}"
          groups   = ["system:bootstrappers", "system:nodes"]
        }
      ],
      # GitHub Actions role for CI/CD deployments (least-privilege via custom RBAC)
      [
        {
          rolearn  = var.github_actions_role_arn
          username = "github-actions"
          groups   = ["github-actions-deployers"]
        }
      ],
      # Any additional roles specified by the user
      var.existing_aws_auth_roles
    ))
  }

  # Force update to ensure node group role is always present
  # This is safe because we explicitly include the node group role above
  force = true
}
