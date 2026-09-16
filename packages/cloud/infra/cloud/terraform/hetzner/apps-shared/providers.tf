provider "hcloud" {
  # HCLOUD_TOKEN must be scoped to this environment apps project.
  token = var.hcloud_token
}
