locals {
  deployer_service_account_email = data.terraform_remote_state.foundation.outputs.service_account_email
}

# Namespaces
resource "kubernetes_namespace" "namespaces" {
  for_each = toset(var.namespaces)

  metadata {
    name = each.value

    labels = {
      name        = each.value
      environment = var.environment
      managed-by  = "terraform"
    }
  }
}

# =============================================================================
# RBAC for CI/CD
# Images are pulled from Artifact Registry natively — no pull secrets needed.
# =============================================================================

# ClusterRole: cluster-level read access
resource "kubernetes_cluster_role" "cluster_reader" {
  metadata {
    name = "github-actions-cluster-reader"
    labels = {
      managed-by = "terraform"
    }
  }

  rule {
    api_groups = [""]
    resources  = ["nodes", "namespaces"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = ["storage.k8s.io"]
    resources  = ["storageclasses"]
    verbs      = ["get", "list", "watch"]
  }
}

# ClusterRoleBinding: bind cluster reader to the CI/CD service account
resource "kubernetes_cluster_role_binding" "cluster_reader" {
  metadata {
    name = "github-actions-cluster-reader"
    labels = {
      managed-by = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role.cluster_reader.metadata[0].name
  }

  subject {
    kind = "User"
    name = local.deployer_service_account_email
  }
}

# Role: namespace-level deployer access (one per namespace)
resource "kubernetes_role" "namespace_deployer" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "github-actions-deployer"
    namespace = kubernetes_namespace.namespaces[each.key].metadata[0].name
    labels = {
      managed-by = "terraform"
    }
  }

  # Core resources
  rule {
    api_groups = [""]
    resources  = ["pods", "pods/log", "pods/exec", "services", "endpoints", "configmaps", "secrets", "serviceaccounts", "persistentvolumeclaims"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Deployments
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets", "statefulsets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Batch jobs (Helm hooks)
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

  # RBAC within namespace
  rule {
    api_groups = ["rbac.authorization.k8s.io"]
    resources  = ["roles", "rolebindings"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }

  # Events (read-only for debugging)
  rule {
    api_groups = [""]
    resources  = ["events"]
    verbs      = ["get", "list", "watch"]
  }

  # CNPG PostgreSQL
  rule {
    api_groups = ["postgresql.cnpg.io"]
    resources  = ["clusters", "backups", "scheduledbackups", "poolers"]
    verbs      = ["get", "list", "watch"]
  }
}

# RoleBinding: bind namespace deployer to the CI/CD service account
resource "kubernetes_role_binding" "namespace_deployer" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "github-actions-deployer"
    namespace = kubernetes_namespace.namespaces[each.key].metadata[0].name
    labels = {
      managed-by = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.namespace_deployer[each.key].metadata[0].name
  }

  subject {
    kind = "User"
    name = local.deployer_service_account_email
  }
}

# =============================================================================
# KEDA — Event-driven autoscaler
# =============================================================================

resource "helm_release" "keda" {
  name             = "keda"
  namespace        = "keda"
  create_namespace = true
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = "2.19.0"
  wait             = true
  timeout          = 180
}

# =============================================================================
# Pepr Operator — ElizaOS Server CRD controller
# =============================================================================

resource "helm_release" "eliza_operator" {
  name             = "eliza-operator"
  namespace        = "pepr-system"
  create_namespace = true
  chart            = "${path.module}/../../../../services/operator/dist/eliza-operator-chart"
  wait             = true
  timeout          = 180

  depends_on = [helm_release.keda]
}

# =============================================================================
# CloudNativePG — Operator + per-namespace clusters
# =============================================================================

# CNPG Operator (Helm)
resource "helm_release" "cnpg_operator" {
  name             = "cnpg"
  namespace        = "cnpg-system"
  create_namespace = true
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = "0.28.0"
  wait             = true
}

# CNPG Cluster per database_clusters entry (Helm)
resource "helm_release" "pg_cluster" {
  for_each = var.database_clusters

  name       = "pg-app"
  namespace  = each.key
  repository = "https://cloudnative-pg.github.io/charts"
  chart      = "cluster"
  version    = "0.6.0"
  wait       = true
  timeout    = 300

  values = [yamlencode({
    type = "postgresql"
    mode = "standalone"
    version = {
      postgresql = tostring(each.value.pg_version)
    }
    cluster = {
      instances = each.value.instances
      storage = {
        size         = each.value.storage_size
        storageClass = each.value.storage_class
      }
      enableSuperuserAccess = true
      initdb = {
        database = "app"
        owner    = "app"
        postInitApplicationSQL = [
          "CREATE EXTENSION IF NOT EXISTS vector;",
          "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
        ]
      }
      resources = {
        requests = { memory = "256Mi", cpu = "250m" }
        limits   = { memory = "512Mi" }
      }
      serviceAccountTemplate = {
        metadata = {
          annotations = {
            "iam.gke.io/gcp-service-account" = data.terraform_remote_state.foundation.outputs.cnpg_backup_sa_email
          }
        }
      }
    }
    backups = {
      enabled         = true
      provider        = "google"
      retentionPolicy = var.environment == "production" ? "30d" : "7d"
      google = {
        bucket         = data.terraform_remote_state.foundation.outputs.pg_backup_bucket_name
        path           = "/${each.key}"
        gkeEnvironment = true
      }
      scheduledBackups = [
        {
          name                 = "daily"
          schedule             = "0 0 2 * * *"
          backupOwnerReference = "self"
        }
      ]
    }
    poolers = [
      {
        name      = "rw"
        type      = "rw"
        instances = each.value.pooler_instances
        poolMode  = "transaction"
        parameters = {
          max_client_conn   = "100"
          default_pool_size = "20"
        }
      }
    ]
  })]

  depends_on = [helm_release.cnpg_operator, kubernetes_namespace.namespaces]
}

# Workload Identity binding: CNPG K8s SA → GCP backup SA
resource "google_service_account_iam_member" "cnpg_workload_identity" {
  for_each = var.database_clusters

  service_account_id = "projects/${data.terraform_remote_state.foundation.outputs.project_id}/serviceAccounts/${data.terraform_remote_state.foundation.outputs.cnpg_backup_sa_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${data.terraform_remote_state.foundation.outputs.project_id}.svc.id.goog[${each.key}/pg-app]"
}

# =============================================================================
# Redis (Bitnami Helm) + redis-rest proxy in eliza-infra
# =============================================================================

# Managed separately from the namespaces loop — do NOT add "eliza-infra" to var.namespaces
resource "kubernetes_namespace" "eliza_infra" {
  metadata {
    name = "eliza-infra"
    labels = {
      name        = "eliza-infra"
      environment = var.environment
      managed-by  = "terraform"
    }
  }
}

# Redis (Bitnami Helm)
resource "helm_release" "redis" {
  name       = "redis"
  namespace  = "eliza-infra"
  repository = "oci://registry-1.docker.io/bitnamicharts"
  chart      = "redis"
  version    = "25.4.1"
  wait       = true
  timeout    = 180

  values = [yamlencode({
    architecture = var.redis_config.architecture
    auth = merge(
      { enabled = var.redis_config.auth_enabled },
      var.redis_config.auth_password != null ? { password = var.redis_config.auth_password } : {}
    )
    master = {
      persistence = {
        size = var.redis_config.persistence_size
      }
      resources = {
        requests = { memory = "128Mi", cpu = "100m" }
        limits   = { memory = "256Mi" }
      }
    }
    replica = {
      replicaCount = var.redis_config.architecture == "replication" ? var.redis_config.replicas : 0
      persistence = {
        size = var.redis_config.persistence_size
      }
      resources = {
        requests = { memory = "128Mi", cpu = "100m" }
        limits   = { memory = "256Mi" }
      }
    }
  })]

  depends_on = [kubernetes_namespace.eliza_infra]
}

# ExternalName alias: redis → redis-master (backward compat for operator, KEDA, tests)
resource "kubernetes_service" "redis_alias" {
  metadata {
    name      = "redis"
    namespace = "eliza-infra"
    labels = {
      managed-by = "terraform"
    }
  }

  spec {
    type          = "ExternalName"
    external_name = "redis-master.eliza-infra.svc.cluster.local"

    port {
      port        = 6379
      target_port = 6379
    }
  }

  depends_on = [helm_release.redis]
}

# redis-rest proxy (Upstash-compatible HTTP interface for gateways)
resource "kubernetes_deployment" "redis_rest" {
  metadata {
    name      = "redis-rest"
    namespace = "eliza-infra"
    labels = {
      app        = "redis-rest"
      managed-by = "terraform"
    }
  }

  spec {
    replicas = var.redis_config.redis_rest_replicas

    selector {
      match_labels = {
        app = "redis-rest"
      }
    }

    template {
      metadata {
        labels = {
          app = "redis-rest"
        }
      }

      spec {
        container {
          name  = "redis-rest"
          image = "hiett/serverless-redis-http:latest"

          port {
            container_port = 80
          }

          env {
            name  = "SRH_MODE"
            value = "env"
          }

          env {
            name  = "SRH_TOKEN"
            value = var.redis_config.redis_rest_token
          }

          env {
            name  = "SRH_CONNECTION_STRING"
            value = var.redis_config.auth_enabled && var.redis_config.auth_password != null ? "redis://:${var.redis_config.auth_password}@redis-master.eliza-infra.svc:6379" : "redis://redis-master.eliza-infra.svc:6379"
          }

          resources {
            requests = {
              memory = "64Mi"
              cpu    = "50m"
            }
            limits = {
              memory = "128Mi"
              cpu    = "100m"
            }
          }
        }
      }
    }
  }

  depends_on = [helm_release.redis]
}

resource "kubernetes_service" "redis_rest" {
  metadata {
    name      = "redis-rest"
    namespace = "eliza-infra"
    labels = {
      app        = "redis-rest"
      managed-by = "terraform"
    }
  }

  spec {
    selector = {
      app = "redis-rest"
    }

    port {
      port        = 8079
      target_port = 80
    }
  }
}
