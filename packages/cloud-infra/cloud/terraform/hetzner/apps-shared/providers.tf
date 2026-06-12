provider "hcloud" {
  # Token resolution order:
  #   1. var.hcloud_token (passed via tfvars or -var)
  #   2. HCLOUD_TOKEN env var (the GHA pattern — sourced from the REPO-level
  #      secret HCLOUD_APPS_TOKEN; the apps Hetzner project is one shared
  #      project across staging + production).
  # See ../ARCHITECTURE.md § "Multi-project layout" for the topology.
  token = var.hcloud_token
}
