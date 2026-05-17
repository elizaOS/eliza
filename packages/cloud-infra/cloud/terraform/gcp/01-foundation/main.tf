locals {
  vpc_name = "${var.cluster_name}-vpc"

  required_apis = [
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "sts.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

# Enable required GCP APIs
resource "google_project_service" "apis" {
  for_each = toset(local.required_apis)
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

# VPC + Cloud NAT
module "network" {
  source = "./modules/network"

  project_id    = var.project_id
  region        = var.region
  environment   = var.environment
  vpc_name      = local.vpc_name
  subnet_cidr   = var.subnet_cidr
  pods_cidr     = var.pods_cidr
  services_cidr = var.services_cidr

  depends_on = [google_project_service.apis]
}

# GKE Autopilot cluster
module "gke" {
  source = "./modules/gke"

  project_id              = var.project_id
  region                  = var.region
  cluster_name            = var.cluster_name
  vpc_id                  = module.network.vpc_self_link
  subnet_id               = module.network.subnet_id
  pods_range_name         = module.network.pods_range_name
  services_range_name     = module.network.services_range_name
  master_ipv4_cidr        = var.master_ipv4_cidr
  master_authorized_cidrs = var.master_authorized_cidrs
  deletion_protection     = var.deletion_protection

  depends_on = [module.network]
}

# Workload Identity Federation for GitHub Actions
module "iam" {
  source = "./modules/iam"

  project_id   = var.project_id
  github_repos = var.github_repos

  depends_on = [google_project_service.apis]
}

# GCS bucket for CNPG PostgreSQL backups (Barman)
resource "google_storage_bucket" "pg_backups" {
  name     = "${var.project_id}-pg-backups"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  force_destroy               = var.environment != "production"

  lifecycle_rule {
    condition {
      age = var.environment == "production" ? 90 : 30
    }
    action {
      type = "Delete"
    }
  }
}

# GCP service account for CNPG backup operations (Barman → GCS)
resource "google_service_account" "cnpg_backup" {
  project      = var.project_id
  account_id   = "cnpg-backup"
  display_name = "CNPG Backup"
  description  = "Service account for CloudNativePG Barman backups to GCS"
}

resource "google_storage_bucket_iam_member" "cnpg_backup_writer" {
  bucket = google_storage_bucket.pg_backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cnpg_backup.email}"
}
