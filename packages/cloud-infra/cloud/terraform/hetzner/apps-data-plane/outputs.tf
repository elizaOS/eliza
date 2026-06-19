# tenant_db_* outputs now live in ../apps-shared (one tenant DB, shared across
# staging + production app nodes). Read them via terraform_remote_state if you
# need them in another module.

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
    1. Confirm tenant_db_admin_dsn from ../apps-shared has been seeded into
       tenant_db_clusters (provider='direct_pg', host=tenant_db_private_ip).
    2. Set the daemon/Worker apps env: CONTAINERS_DOCKER_NODES (app_node_ips),
       CONTAINERS_PUBLIC_BASE_DOMAIN=${var.apps_base_domain}, the image registry,
       CONTAINERS_EGRESS_PROXY_URL.
    3. Wire the 2 boot one-liners (cloud-api configureAppsDeployTrigger + daemon
       configureAppsDeployBackend) and flip the feature gate for an allowlist.
    4. On-node kernel re-check (throwaway --internal scratch net on an app node)
       before opening to users.
  EOT
}
