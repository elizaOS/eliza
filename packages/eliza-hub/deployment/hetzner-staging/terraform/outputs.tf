output "server_id" {
  description = "Hetzner server identifier."
  value       = hcloud_server.forge.id
}

output "server_ipv4" {
  description = "Static public IPv4 address for the Eliza Hub host."
  value       = hcloud_primary_ip.forge.ip_address
}

output "web_url" {
  description = "Canonical Forgejo URL."
  value       = "https://${var.web_hostname}/"
}

output "steward_url" {
  description = "Canonical Merge Steward base URL."
  value       = "https://${var.web_hostname}/steward"
}

output "operator_ssh_command" {
  description = "Host administration command."
  value       = "ssh -p ${var.operator_ssh_port} ${var.operator_user}@${hcloud_primary_ip.forge.ip_address}"
}

output "forgejo_ssh_base" {
  description = "Native Forgejo SSH clone URL prefix."
  value       = "ssh://git@${var.ssh_hostname}:${var.git_ssh_port}/"
}

output "deployment_env_overrides" {
  description = "Non-secret values to place in the private deployment .env on the host."
  value = {
    FORGEJO_DOMAIN          = var.web_hostname
    FORGEJO_ROOT_URL        = "https://${var.web_hostname}/"
    FORGEJO_SSH_BIND        = "0.0.0.0"
    FORGEJO_SSH_DOMAIN      = var.ssh_hostname
    FORGEJO_SSH_PORT        = tostring(var.git_ssh_port)
    FORGEJO_PUBLIC_SSH_PORT = tostring(var.git_ssh_port)
    MERGE_STEWARD_URL       = "https://${var.web_hostname}/steward"
  }
}
