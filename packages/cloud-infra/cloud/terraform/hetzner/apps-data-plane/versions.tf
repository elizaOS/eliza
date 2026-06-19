terraform {
  # 1.10+ is required for S3 backend `use_lockfile = true` (native lockfile
  # without DynamoDB), which is how we serialize state writes on Cloudflare R2
  # — R2 has no DynamoDB equivalent, so the alternative would be silent races.
  required_version = ">= 1.10.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.63"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State backend uses Cloudflare R2 (S3-compatible), same as control-plane.
  #   terraform init -backend-config=backend-staging.hcl
  #   terraform init -backend-config=backend-production.hcl
  backend "s3" {}
}
