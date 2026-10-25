variable "environment" {
  description = "Environment name (development, production)"
  type        = string
  validation {
    condition     = contains(["development", "production"], var.environment)
    error_message = "Environment must be 'development' or 'production'"
  }
}

variable "namespaces" {
  description = "List of Kubernetes namespaces to create"
  type        = list(string)
  default     = []
}

variable "redis_config" {
  description = "Redis (Bitnami Helm) configuration for the eliza-infra namespace"
  type = object({
    architecture        = optional(string, "standalone")
    replicas            = optional(number, 1)
    persistence_size    = optional(string, "2Gi")
    auth_enabled        = optional(bool, true)
    auth_password       = optional(string)
    redis_rest_replicas = optional(number, 2)
    redis_rest_token    = optional(string)
  })
  default = {}
}

variable "database_clusters" {
  description = "CNPG PostgreSQL clusters to deploy (key = namespace/org UUID)"
  type = map(object({
    instances        = optional(number, 1)
    storage_size     = optional(string, "10Gi")
    storage_class    = optional(string, "premium-rwo")
    pg_version       = optional(number, 17)
    pooler_instances = optional(number, 1)
  }))
  default = {}
}
