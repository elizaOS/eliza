provider "hcloud" {
  # Token comes from HCLOUD_TOKEN env var by default — never commit it.
  # token = var.hcloud_token
}

provider "cloudflare" {
  # Token comes from CLOUDFLARE_API_TOKEN env var by default.
  # api_token = var.cloudflare_api_token
}
