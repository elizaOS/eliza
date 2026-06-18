# Outputs consumed by the apps-data-plane module via terraform_remote_state.

output "apps_network_id" {
  description = "ID of the shared apps private network. apps-data-plane attaches app_node servers to this via hcloud_server_network."
  value       = hcloud_network.apps.id
}

output "apps_subnet_id" {
  description = "ID of the shared apps subnet. Mostly informational — server attachments only need network_id, but useful for debugging."
  value       = hcloud_network_subnet.apps.id
}

output "apps_subnet_cidr" {
  description = "CIDR of the shared apps subnet. apps-data-plane computes app_node private IPs per env via cidrhost(subnet, base + i) where base = 20 (staging) / 30 (production); tenant DB is host 10."
  value       = var.subnet_cidr
}

output "tenant_db_private_ip" {
  description = "Private-network IP of the tenant Postgres node (10.30.1.10). This is the HOST for the admin DSN seeded into tenant_db_clusters.admin_dsn_encrypted, and the host the app's per-tenant DSN points at."
  value       = cidrhost(var.subnet_cidr, 10)
}

output "tenant_db_public_ip" {
  description = "Public IP of the tenant DB node (SSH/admin only — Postgres is NOT exposed publicly)."
  value       = hcloud_server.tenant_db.ipv4_address
}

output "tenant_db_admin_dsn" {
  description = "Admin DSN for the tenant Postgres cluster (over the PRIVATE network). Encrypt this and seed it into tenant_db_clusters.admin_dsn_encrypted. SENSITIVE."
  value       = "postgresql://postgres:${random_password.tenant_db_admin.result}@${cidrhost(var.subnet_cidr, 10)}:5432/postgres?sslmode=require"
  sensitive   = true
}
