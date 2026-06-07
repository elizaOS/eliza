terraform {
  required_version = ">= 1.5.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.63"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State backend uses Cloudflare R2 (S3-compatible), same as control-plane.
  #   terraform init -backend-config=backend-staging.hcl
  #   terraform init -backend-config=backend-production.hcl
  backend "s3" {}
}
