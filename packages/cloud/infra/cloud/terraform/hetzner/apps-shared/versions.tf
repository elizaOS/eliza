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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Select backend-<environment>.hcl with credentials scoped to its R2 bucket.
  backend "s3" {}
}
