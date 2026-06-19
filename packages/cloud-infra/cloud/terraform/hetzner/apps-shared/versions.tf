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

  # State backend uses Cloudflare R2 (S3-compatible), same as apps-data-plane.
  # Single shared backend file — this module is NOT per-env (one private network +
  # one tenant Postgres are shared across staging + production app nodes).
  #   terraform init -backend-config=backend.hcl
  backend "s3" {}
}
