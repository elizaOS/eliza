variable "environment" {
  description = "The single environment owning this network and tenant database."
  type        = string
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Select development, staging, or production; shared tenant database state is not an environment."
  }
}

# Use a project token scoped to this environment's apps infrastructure.
# Worker and database roots share that project's network within one tier only.
variable "hcloud_token" {
  description = "Hetzner token for this environment apps project; null uses HCLOUD_TOKEN."
  type        = string
  default     = null
  sensitive   = true
}

variable "hcloud_location" {
  description = "Hetzner Cloud datacenter location. MUST match the apps-data-plane location so app nodes can attach to the shared private network."
  type        = string
  default     = "fsn1"
}

variable "hcloud_image" {
  description = "Base image for the tenant DB VM."
  type        = string
  default     = "ubuntu-24.04"
}

# ── Tenant Postgres cluster node: thousands of DATABASE+ROLE per node ─────────
variable "tenant_db_server_type" {
  description = "Hetzner server type for the tenant Postgres node. cpx42 (8 shared vCPU / 16 GB AMD) — no dedicated-CPU quota required. Postgres runs server-side (no untrusted code execution on this VM), so shared CPU is fine for isolation; the boundary is hostssl + private-network firewall + per-tenant ROLE. For perf-sensitive workloads, override to ccx33 (dedicated 8 vCPU / 32 GB)."
  type        = string
  default     = "cpx42"
}

variable "tenant_db_volume_size_gb" {
  description = "Size of the attached block-storage volume that holds all tenant databases (PGDATA lives here so the node can be rebuilt without data loss)."
  type        = number
  default     = 200
}

variable "ssh_public_keys" {
  description = "Operator SSH public keys allowed to log in as `deploy` on the tenant DB node. Provide via tfvars; never commit private keys."
  type        = list(string)
  default     = []
}

variable "network_cidr" {
  description = "Private network CIDR for the apps data plane. MUST NOT overlap the agent data-plane network — apps and agents are isolated."
  type        = string
  default     = "10.30.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet within network_cidr where the app nodes + tenant DB attach."
  type        = string
  default     = "10.30.1.0/24"
}

variable "operator_ingress_cidrs" {
  description = "CIDRs allowed to SSH the tenant DB node (operator IPs / control-plane). No default: the workflow MUST supply a tight list — '0.0.0.0/0' is explicitly rejected by the validation below to fail closed on every apply."
  type        = list(string)
  validation {
    condition     = length(var.operator_ingress_cidrs) > 0 && alltrue([for c in var.operator_ingress_cidrs : c != "0.0.0.0/0" && c != "::/0"])
    error_message = "operator_ingress_cidrs MUST be a non-empty list of tight CIDRs (no 0.0.0.0/0 or ::/0); pin to operator IPs or the control-plane IP"
  }
}

# ── Off-host encrypted backups (#21729) ──────────────────────────────────────
# Hetzner provider snapshots (`backups = true` on the server) are a host
# safeguard, not an application-consistent database backup: they cannot prove
# a restorable Postgres state and they live in the same failure domain. These
# variables arm the on-node nightly logical-backup pipeline that dumps every
# tenant database, encrypts the archive locally with AES-256, and ships it to
# an S3-compatible bucket OUTSIDE the Hetzner apps project (e.g. a dedicated
# R2 bucket). All of endpoint/bucket/access/secret/passphrase must be set
# together; leaving them empty keeps the pipeline installed but INERT — the
# tenant_db server precondition in main.tf rejects partial configuration.
variable "pitr_repository" {
  description = "Dedicated encrypted WAL/PITR repository, separate from logical-dump retention and Terraform state. Null leaves existing host configuration unchanged. Credentials and encryption key require independent recovery custody."
  type = object({
    endpoint   = string
    bucket     = string
    region     = string
    access_key = string
    secret_key = string
    cipher_key = string
  })
  default   = null
  sensitive = true
  validation {
    condition = var.pitr_repository == null ? true : (
      can(regex("^[a-zA-Z0-9][a-zA-Z0-9.-]+[a-zA-Z0-9]$", var.pitr_repository.endpoint)) &&
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.pitr_repository.bucket)) &&
      !startswith(var.pitr_repository.bucket, "eliza-terraform-state") &&
      can(regex("^[a-zA-Z0-9-]+$", var.pitr_repository.region)) &&
      length(var.pitr_repository.cipher_key) >= 32 &&
      alltrue([for value in [var.pitr_repository.access_key, var.pitr_repository.secret_key, var.pitr_repository.cipher_key] : length(trimspace(value)) > 0 && !can(regex("[\\r\\n]", value))])
    )
    error_message = "PITR requires a hostname-only TLS endpoint, dedicated bucket, region, nonempty single-line credentials and an encryption key of at least 32 characters."
  }
}

variable "backup_s3_endpoint" {
  description = "S3-compatible endpoint URL for off-host tenant-DB backups. Empty disables the backup pipeline."
  type        = string
  default     = ""
}

variable "backup_s3_bucket" {
  description = "Bucket for off-host tenant-DB backups. MUST be a dedicated backup bucket — never the terraform state bucket — so a state-bucket credential leak cannot also read tenant data."
  type        = string
  default     = ""
  validation {
    condition     = !startswith(var.backup_s3_bucket, "eliza-terraform-state")
    error_message = "backup_s3_bucket must be a dedicated backup bucket, never the terraform state bucket"
  }
}

variable "backup_s3_prefix" {
  description = "Object key prefix under which dated backup sets are written. The nightly job's retention purge deletes everything under this prefix that is older than the cutoff, so an empty or unbounded value would scope that delete sweep to the bucket root; the node script re-validates this at runtime as defense in depth."
  type        = string
  default     = "tenant-db"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$", var.backup_s3_prefix)) && !can(regex("\\.\\.", var.backup_s3_prefix)) && !endswith(var.backup_s3_prefix, "/")
    error_message = "backup_s3_prefix must be non-empty, at most 200 characters, contain only [A-Za-z0-9._/-], and must not contain '..' or end with '/'"
  }
}

variable "backup_s3_access_key" {
  description = "Access key id for the backup bucket. Scope the token to this bucket only (write + list + delete for retention pruning). SENSITIVE."
  type        = string
  default     = ""
  sensitive   = true
}

variable "backup_s3_secret_key" {
  description = "Secret access key for the backup bucket. SENSITIVE."
  type        = string
  default     = ""
  sensitive   = true
}

variable "backup_encryption_passphrase" {
  description = "Symmetric passphrase used to AES-256 encrypt every backup archive BEFORE upload, so the bucket operator never sees tenant plaintext. Custody: org password manager (cloud-ops vault); losing it makes every off-host backup unreadable. SENSITIVE."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.backup_encryption_passphrase == "" || length(var.backup_encryption_passphrase) >= 32
    error_message = "backup_encryption_passphrase must be empty (disabled) or at least 32 characters"
  }
}

variable "backup_retention_days" {
  description = "Days of dated backup sets retained off-host before the nightly job prunes them. Floor of 7 keeps at least a week of restore points."
  type        = number
  default     = 14
  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "backup_retention_days must be at least 7"
  }
}
