# Cluster
output "cluster_name" {
  description = "GKE cluster name"
  value       = module.gke.cluster_name
}

output "cluster_endpoint" {
  description = "GKE cluster API endpoint"
  value       = module.gke.cluster_endpoint
  sensitive   = true
}

output "cluster_ca_certificate" {
  description = "GKE cluster CA certificate (base64)"
  value       = module.gke.cluster_ca_certificate
  sensitive   = true
}

output "cluster_location" {
  description = "GKE cluster location (region)"
  value       = module.gke.cluster_location
}

output "kubeconfig_command" {
  description = "gcloud command to configure kubectl"
  value       = "gcloud container clusters get-credentials ${module.gke.cluster_name} --region ${var.region} --project ${var.project_id}"
}

# Network
output "vpc_name" {
  description = "VPC network name"
  value       = module.network.vpc_name
}

# IAM
output "workload_identity_provider" {
  description = "Workload Identity Provider resource name (use in GitHub Actions 'google-github-actions/auth')"
  value       = module.iam.workload_identity_provider
}

output "service_account_email" {
  description = "Service account email for GitHub Actions deployments"
  value       = module.iam.service_account_email
}

# CNPG PostgreSQL backups
output "pg_backup_bucket_name" {
  description = "GCS bucket name for CNPG Barman backups"
  value       = google_storage_bucket.pg_backups.name
}

output "cnpg_backup_sa_email" {
  description = "GCP service account email for CNPG backup operations"
  value       = google_service_account.cnpg_backup.email
}

# Passthrough for 02-k8s layer
output "project_id" {
  description = "GCP project ID"
  value       = var.project_id
}

output "region" {
  description = "GCP region"
  value       = var.region
}
