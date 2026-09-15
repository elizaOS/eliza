# Exercises repository admission in actual Terraform plans without cloud effects.
mock_provider "hcloud" {}
mock_provider "random" {}
variables {
  environment            = "development"
  operator_ingress_cidrs = ["192.0.2.1/32"]
  pitr_repository = {
    endpoint   = "objects.example.invalid"
    bucket     = "tenant-pitr-development"
    region     = "auto"
    access_key = "fixture-access"
    secret_key = "fixture-secret"
    cipher_key = "fixture-only-key-never-used-for-real-data"
  }
}
run "admit_complete_repository" {
  command = plan
}
run "reject_multiline_configuration_injection" {
  command = plan
  variables {
    pitr_repository = {
      endpoint   = "objects.example.invalid"
      bucket     = "tenant-pitr-development"
      region     = "auto"
      access_key = "fixture-access"
      secret_key = "fixture-secret\nrepo1-storage-verify-tls=n"
      cipher_key = "fixture-only-key-never-used-for-real-data"
    }
  }
  expect_failures = [var.pitr_repository]
}
run "reject_logical_expiry_bucket" {
  command = plan
  variables {
    backup_s3_endpoint           = "https://objects.example.invalid"
    backup_s3_bucket             = "tenant-pitr-development"
    backup_s3_access_key         = "fixture-access"
    backup_s3_secret_key         = "fixture-secret"
    backup_encryption_passphrase = "fixture-only-key-never-used-for-real-data"
  }
  expect_failures = [hcloud_server.tenant_db]
}
