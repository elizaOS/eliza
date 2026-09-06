# Plans the actual tenant infrastructure with provider effects mocked.
mock_provider "hcloud" {}
mock_provider "random" {}
variables {
  environment            = "development"
  operator_ingress_cidrs = ["192.0.2.1/32"]
}
run "development_database" { command = plan }
run "staging_database" {
  command = plan
  variables { environment = "staging" }
}
run "production_database" {
  command = plan
  variables { environment = "production" }
}
run "reject_shared_environment" {
  command = plan
  variables { environment = "shared" }
  expect_failures = [var.environment]
}
run "reject_environment_state_bucket_for_backup" {
  command = plan
  variables { backup_s3_bucket = "eliza-terraform-state-development" }
  expect_failures = [var.backup_s3_bucket]
}
