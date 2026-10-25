environment = "development"
namespaces  = ["9437543e-c21f-42a4-9dd9-6e697d0d75eb", "gateways"]

redis_config = {
  architecture        = "standalone"
  persistence_size    = "2Gi"
  auth_enabled        = false
  redis_rest_replicas = 1
  redis_rest_token    = "dev-internal-token"
}

database_clusters = {
  "9437543e-c21f-42a4-9dd9-6e697d0d75eb" = {
    instances    = 1
    storage_size = "10Gi"
  }
}
