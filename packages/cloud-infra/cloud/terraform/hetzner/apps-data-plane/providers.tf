provider "hcloud" {
  # Token resolution order:
  #   1. var.hcloud_token (passed via tfvars or -var)
  #   2. HCLOUD_TOKEN env var (the GHA pattern — sourced from the REPO-level
  #      secret HCLOUD_APPS_TOKEN; both staging + production applies share it
  #      because the apps data-plane lives in a single shared Hetzner Cloud
  #      Project, NOT split per environment like the control-plane is).
  # See ../ARCHITECTURE.md § "Multi-project layout" for the topology.
  token = var.hcloud_token
}

provider "cloudflare" {
  # Token comes from CLOUDFLARE_API_TOKEN env var (no per-env variable needed
  # — the Cloudflare project is one shared account, not split by environment).
}
