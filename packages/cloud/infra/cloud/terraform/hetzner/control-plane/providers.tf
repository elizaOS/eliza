provider "hcloud" {
  # Token resolution order:
  #   1. var.hcloud_token (passed via tfvars or -var)
  #   2. HCLOUD_TOKEN env var (the GHA pattern — set per GitHub Environment)
  # Each environment uses a token scoped to its OWN Hetzner Cloud Project.
  # See ../ARCHITECTURE.md § "Multi-project layout".
  token = var.hcloud_token
}

provider "cloudflare" {
  # Token comes from CLOUDFLARE_API_TOKEN env var (no per-env variable needed
  # — the Cloudflare project is one shared account, not split by environment).
}
