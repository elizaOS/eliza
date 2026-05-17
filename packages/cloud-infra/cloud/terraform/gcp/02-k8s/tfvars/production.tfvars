environment = "production"
namespaces  = ["9437543e-c21f-42a4-9dd9-6e697d0d75eb", "gateways"]

redis_config = {
  architecture        = "replication"
  replicas            = 2
  persistence_size    = "5Gi"
  auth_enabled        = true
  auth_password       = "REPLACE_WITH_SECURE_PASSWORD"
  redis_rest_replicas = 2
  redis_rest_token    = "REPLACE_WITH_SECURE_TOKEN"
}

database_clusters = {
  "9437543e-c21f-42a4-9dd9-6e697d0d75eb" = {
    instances        = 2
    storage_size     = "20Gi"
    pooler_instances = 2
  }
}
