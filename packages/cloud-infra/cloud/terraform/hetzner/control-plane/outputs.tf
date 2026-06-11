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

output "data_plane_network_id" {
  description = "Hetzner ID of the private network the autoscaler attaches workers to. Set this as CONTAINERS_HCLOUD_NETWORK_IDS in /opt/eliza/cloud/.env.local on the CP."
  value       = hcloud_network.data_plane.id
}

output "data_plane_subnet_cidr" {
  description = "Subnet CIDR for the data-plane network — useful when wiring static routes or firewall rules on the CP."
  value       = hcloud_network_subnet.data_plane.ip_range
}
