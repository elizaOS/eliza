# Cloudflare R2 backend (S3-compatible) for terraform state.
#
# Set up once per environment:
#   1. Create R2 bucket `eliza-terraform-state` in the elizaOS CF account.
#   2. Generate R2 API token with read/write on that bucket.
#   3. Export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY pointing at the
#      R2 token before `terraform init`.
#
# Usage:
#   terraform init -backend-config=backend-staging.hcl

bucket                      = "eliza-terraform-state"
key                         = "hetzner/control-plane/staging.tfstate"
region                      = "auto"
endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true
use_path_style              = true

# Native S3 backend lockfile (requires TF 1.10+). No DynamoDB needed.
use_lockfile                = true
