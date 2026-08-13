provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN supplies the credential. It needs Pages Read/Write and
  # DNS Read/Write for eliza.app and the redirect-only elizacloud.ai zone; no
  # token enters Terraform state.
}
