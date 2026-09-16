provider "hcloud" {
  # HCLOUD_TOKEN must be scoped to this environment apps project.
  token = var.hcloud_token
}

provider "cloudflare" {
  # Token comes from CLOUDFLARE_API_TOKEN env var (no per-env variable needed
  # — the Cloudflare project is one shared account, not split by environment).
}
