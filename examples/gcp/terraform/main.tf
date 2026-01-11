# Terraform configuration for elizaOS Cloud Run deployment
#
# Usage:
#   cd terraform
#   terraform init
#   terraform plan -var="openai_api_key=$OPENAI_API_KEY"
#   terraform apply -var="openai_api_key=$OPENAI_API_KEY"

terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

# Variables
variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run"
  type        = string
  default     = "us-central1"
}

variable "runtime" {
  description = "Runtime to deploy: typescript, python, or rust"
  type        = string
  default     = "typescript"
}

variable "service_name" {
  description = "Base name for the Cloud Run service"
  type        = string
  default     = "eliza-worker"
}

variable "openai_api_key" {
  description = "OpenAI API key"
  type        = string
  sensitive   = true
}

variable "openai_model" {
  description = "OpenAI model to use"
  type        = string
  default     = "gpt-5-mini"
}

variable "character_name" {
  description = "AI character name"
  type        = string
  default     = "Eliza"
}

variable "character_bio" {
  description = "AI character bio"
  type        = string
  default     = "A helpful AI assistant."
}

variable "min_instances" {
  description = "Minimum number of instances"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of instances"
  type        = number
  default     = 100
}

variable "memory" {
  description = "Memory allocation"
  type        = string
  default     = "512Mi"
}

variable "cpu" {
  description = "CPU allocation"
  type        = string
  default     = "1"
}

variable "timeout_seconds" {
  description = "Request timeout in seconds"
  type        = number
  default     = 60
}

# Provider configuration
provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudbuild" {
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# Artifact Registry repository
resource "google_artifact_registry_repository" "eliza" {
  location      = var.region
  repository_id = "eliza"
  description   = "elizaOS container images"
  format        = "DOCKER"

  depends_on = [google_project_service.artifactregistry]
}

# Secret for OpenAI API key
resource "google_secret_manager_secret" "openai_key" {
  secret_id = "openai-api-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "openai_key" {
  secret      = google_secret_manager_secret.openai_key.id
  secret_data = var.openai_api_key
}

# Service account for Cloud Run
resource "google_service_account" "eliza_worker" {
  account_id   = "eliza-worker"
  display_name = "elizaOS Cloud Run Worker"
}

# Grant secret access to service account
resource "google_secret_manager_secret_iam_member" "openai_key_access" {
  secret_id = google_secret_manager_secret.openai_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.eliza_worker.email}"
}

# Cloud Run service
resource "google_cloud_run_v2_service" "eliza_worker" {
  name     = "${var.service_name}-${var.runtime}"
  location = var.region

  template {
    service_account = google_service_account.eliza_worker.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/eliza/${var.service_name}-${var.runtime}:latest"

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      env {
        name  = "CHARACTER_NAME"
        value = var.character_name
      }

      env {
        name  = "CHARACTER_BIO"
        value = var.character_bio
      }

      env {
        name  = "OPENAI_MODEL"
        value = var.openai_model
      }

      env {
        name  = "LOG_LEVEL"
        value = "INFO"
      }

      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.openai_key.secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
      }
    }

    timeout = "${var.timeout_seconds}s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.run,
    google_artifact_registry_repository.eliza,
    google_secret_manager_secret_version.openai_key,
    google_secret_manager_secret_iam_member.openai_key_access,
  ]
}

# Allow unauthenticated access
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  location = google_cloud_run_v2_service.eliza_worker.location
  name     = google_cloud_run_v2_service.eliza_worker.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Outputs
output "service_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.eliza_worker.uri
}

output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.eliza_worker.name
}

output "repository_url" {
  description = "Artifact Registry repository URL"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.eliza.repository_id}"
}










