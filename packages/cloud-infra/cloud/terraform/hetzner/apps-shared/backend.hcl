# Cloudflare R2 backend (S3-compatible) for terraform state — apps-shared.
# Single shared backend file: this module is NOT per-env (one private network +
# one tenant Postgres node are shared across staging + production app nodes).
# Mirrors apps-data-plane/backend-*.hcl on bucket + R2 account.
#
# Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to an R2 API token with
# read/write on the bucket, then:
#   terraform init -backend-config=backend.hcl

bucket                      = "eliza-terraform-state"
key                         = "hetzner/apps-shared/shared.tfstate"
region                      = "auto"
endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true
use_path_style              = true

# Native S3 backend lockfile (requires TF 1.10+). No DynamoDB needed.
use_lockfile = true
