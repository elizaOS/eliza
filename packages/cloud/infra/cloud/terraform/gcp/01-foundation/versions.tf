terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.30"
    }
  }

  backend "gcs" {
    # Configure via backend config file:
    # terraform init -backend-config=backend-development.hcl
  }
}
