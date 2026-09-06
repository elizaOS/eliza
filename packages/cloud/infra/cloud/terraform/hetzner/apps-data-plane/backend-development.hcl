# Environment state uses a separate R2 bucket and bucket-scoped credentials.
# Provision this bucket before init; use credentials scoped only to development state.
bucket                      = "eliza-terraform-state-development"
key                         = "hetzner/apps-data-plane/development.tfstate"
region                      = "auto"
endpoints                   = { s3 = "https://23cf6feaeaa541f6a0675053c33da768.r2.cloudflarestorage.com" }
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true
use_path_style              = true
use_lockfile                = true
