output "runner" {
  description = "Non-secret identity needed to register and verify the protected runner."
  value = {
    server_id   = hcloud_server.prod_ops.id
    name        = hcloud_server.prod_ops.name
    ipv4        = hcloud_server.prod_ops.ipv4_address
    firewall_id = hcloud_firewall.prod_ops.id
    role        = hcloud_server.prod_ops.labels["role"]
  }
}
