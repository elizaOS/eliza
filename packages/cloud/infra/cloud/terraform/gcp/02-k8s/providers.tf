data "terraform_remote_state" "foundation" {
  backend = "gcs"

  config = {
    bucket = "eliza-cloud-terraform-state"
    prefix = "gcp/foundation/${var.environment}"
  }
}

data "google_client_config" "default" {}

locals {
  cluster_endpoint       = data.terraform_remote_state.foundation.outputs.cluster_endpoint
  cluster_ca_certificate = data.terraform_remote_state.foundation.outputs.cluster_ca_certificate
}

provider "google" {
  project = data.terraform_remote_state.foundation.outputs.project_id
  region  = data.terraform_remote_state.foundation.outputs.region
}

provider "kubernetes" {
  host                   = "https://${local.cluster_endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(local.cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${local.cluster_endpoint}"
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(local.cluster_ca_certificate)
  }
}
