# Backend configuration for development environment
# Usage: terraform init -backend-config=backend-development.hcl

bucket         = "eliza-cloud-terraform-state"
key            = "development/gateway-discord/terraform.tfstate"
region         = "us-east-1"
encrypt        = true
dynamodb_table = "terraform-state-lock"
