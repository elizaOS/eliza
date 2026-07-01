output "cluster_name" {
  description = "The name of the GKE cluster"
  value       = google_container_cluster.autopilot.name
}

output "cluster_id" {
  description = "The unique identifier of the cluster"
  value       = google_container_cluster.autopilot.id
}

output "cluster_endpoint" {
  description = "The endpoint of the GKE cluster API server"
  value       = google_container_cluster.autopilot.endpoint
}

output "cluster_ca_certificate" {
  description = "Base64 encoded CA certificate of the cluster"
  value       = google_container_cluster.autopilot.master_auth[0].cluster_ca_certificate
  sensitive   = true
}

output "cluster_location" {
  description = "The location (region) of the cluster"
  value       = google_container_cluster.autopilot.location
}
