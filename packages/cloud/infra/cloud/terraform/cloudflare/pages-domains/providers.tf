provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN supplies the credential. It needs Pages Read/Write and
  # DNS Read/Write for the elizacloud.ai zone; no token enters Terraform state.
}
