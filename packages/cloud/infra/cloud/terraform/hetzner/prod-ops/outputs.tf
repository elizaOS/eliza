output "runners" {
  description = "Non-secret identities used to arm and verify each protected one-job runner."
  value = {
    for slot, runner in hcloud_server.prod_ops : slot => {
      server_id   = runner.id
      name        = runner.name
      ipv4        = runner.ipv4_address
      firewall_id = hcloud_firewall.prod_ops.id
      role        = runner.labels["role"]
    }
  }
}
