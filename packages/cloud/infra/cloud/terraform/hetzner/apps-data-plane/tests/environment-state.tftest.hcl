# Exercises remote-state identity admission through actual Terraform planning.
# Providers and remote-state transport are substituted; no cloud effects run.
mock_provider "hcloud" {}
mock_provider "cloudflare" {}
variables {
  environment             = "development"
  cloudflare_zone_id      = "00000000000000000000000000000001"
  eliza_app_zone_id       = "00000000000000000000000000000002"
  legacy_apps_base_domain = "apps-development.elizacloud.ai"
  apps_base_domain        = "apps-development.eliza.app"
  cloud_api_origin        = "https://api-development.eliza.app"
  operator_ingress_cidrs  = ["192.0.2.1/32"]
}
run "matching_database" {
  command = plan
  override_data {
    target = data.terraform_remote_state.apps_shared
    values = {
      outputs = {
        environment          = "development"
        apps_network_id      = 1001
        apps_subnet_cidr     = "10.30.1.0/24"
        tenant_db_private_ip = "10.30.1.10"
      }
    }
  }
}
run "reject_production_database" {
  command = plan
  override_data {
    target = data.terraform_remote_state.apps_shared
    values = {
      outputs = {
        environment          = "production"
        apps_network_id      = 1001
        apps_subnet_cidr     = "10.30.1.0/24"
        tenant_db_private_ip = "10.30.1.10"
      }
    }
  }
  expect_failures = [data.terraform_remote_state.apps_shared]
}
run "reject_staging_database" {
  command = plan
  override_data {
    target = data.terraform_remote_state.apps_shared
    values = {
      outputs = {
        environment          = "staging"
        apps_network_id      = 1001
        apps_subnet_cidr     = "10.30.1.0/24"
        tenant_db_private_ip = "10.30.1.10"
      }
    }
  }
  expect_failures = [data.terraform_remote_state.apps_shared]
}
run "reject_unattested_database" {
  command = plan
  override_data {
    target = data.terraform_remote_state.apps_shared
    values = {
      outputs = {
        apps_network_id      = 1001
        apps_subnet_cidr     = "10.30.1.0/24"
        tenant_db_private_ip = "10.30.1.10"
      }
    }
  }
  expect_failures = [data.terraform_remote_state.apps_shared]
}
