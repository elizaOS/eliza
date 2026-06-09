output "tenant_db_private_host" {
  description = "Private-network IP of the tenant Postgres node. This is the HOST for the admin DSN seeded into tenant_db_clusters.admin_dsn_encrypted, and the host the app's per-tenant DSN points at."
  value       = cidrhost(var.subnet_cidr, 10)
}

output "tenant_db_public_ip" {
  description = "Public IP of the tenant DB node (SSH/admin only — Postgres is NOT exposed publicly). null when provision_tenant_db = false (app-node-only beta)."
  value       = one(hcloud_server.tenant_db[*].ipv4_address)
}

output "tenant_db_admin_dsn" {
  description = "Admin DSN for the tenant Postgres cluster (over the PRIVATE network). Encrypt this and seed it into tenant_db_clusters.admin_dsn_encrypted. SENSITIVE."
  value       = "postgresql://postgres:${random_password.tenant_db_admin.result}@${cidrhost(var.subnet_cidr, 10)}:5432/postgres?sslmode=require"
  sensitive   = true
}

output "app_node_ips" {
  description = "Public IPs of the app worker nodes (the daemon SSHes here to run app containers; ingress also lands here)."
  value       = { for k, v in hcloud_server.app_node : k => v.ipv4_address }
}

output "app_node_private_ips" {
  description = "Private-network IPs of the app worker nodes."
  value       = { for k, v in hcloud_server_network.app_node : k => v.ip }
}

output "apps_wildcard_hostname" {
  description = "Wildcard ingress hostname (CONTAINERS_PUBLIC_BASE_DOMAIN). Set this as the apps base domain in the daemon/Worker env."
  value       = "*.${var.apps_base_domain}"
}

output "next_steps" {
  description = "What to do after apply."
  value       = <<-EOT
    1. Encrypt tenant_db_admin_dsn and seed it into tenant_db_clusters (provider='direct_pg', host=tenant_db_private_host).
    2. Set the daemon/Worker apps env: CONTAINERS_DOCKER_NODES (app_node_ips), CONTAINERS_PUBLIC_BASE_DOMAIN=${var.apps_base_domain}, the image registry, CONTAINERS_EGRESS_PROXY_URL.
    3. Wire the 2 boot one-liners (cloud-api configureAppsDeployTrigger + daemon configureAppsDeployBackend) and flip the feature gate for an allowlist.
    4. On-node kernel re-check (throwaway --internal scratch net on an app node) before opening to users.
  EOT
}
