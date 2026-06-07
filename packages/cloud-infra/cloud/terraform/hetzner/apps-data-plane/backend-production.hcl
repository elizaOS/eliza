# Cloudflare R2 backend (S3-compatible) for terraform state — apps data-plane,
# production. Mirrors control-plane/backend-production.hcl (same bucket + R2 account).
#
# Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to an R2 API token with
# read/write on the bucket, then:
#   terraform init -backend-config=backend-production.hcl

bucket                      = "eliza-terraform-state"
key                         = "hetzner/apps-data-plane/production.tfstate"
region                      = "auto"
endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true
use_path_style              = true
