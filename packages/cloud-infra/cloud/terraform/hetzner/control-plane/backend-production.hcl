bucket                      = "eliza-terraform-state"
key                         = "hetzner/control-plane/production.tfstate"
region                      = "auto"
endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true
use_path_style              = true

# Native S3 backend lockfile (requires TF 1.10+). No DynamoDB needed.
use_lockfile                = true
