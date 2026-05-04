# Backend configuration for production environment
# Usage: terraform init -backend-config=backend-production.hcl

bucket         = "eliza-cloud-terraform-state"
key            = "production/gateway-discord/terraform.tfstate"
region         = "us-east-1"
encrypt        = true
dynamodb_table = "terraform-state-lock"
