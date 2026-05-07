output "namespace" {
  description = "Kubernetes namespace name"
  value       = kubernetes_namespace.gateway_discord.metadata[0].name
}

output "ghcr_secret_name" {
  description = "GHCR credentials secret name"
  value       = kubernetes_secret.ghcr_credentials.metadata[0].name
}

output "app_secret_name" {
  description = "Application secrets name"
  value       = kubernetes_secret.gateway_discord_secrets.metadata[0].name
}
