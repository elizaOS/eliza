output "control_plane_vms" {
  description = "Map of control-plane VMs keyed by index, with IPv4 + hostname."
  value = {
    for k, v in hcloud_server.control_plane : k => {
      name     = v.name
      ipv4     = v.ipv4_address
      ipv6     = v.ipv6_address
      hostname = "${var.control_plane_hostname_prefix}-${var.environment}-${k}.elizacloud.ai"
    }
  }
}

output "ssh_login_commands" {
  description = "Convenience: SSH commands the operator can copy-paste."
  value = {
    for k, v in hcloud_server.control_plane : k => "ssh root@${v.ipv4_address}"
  }
}
