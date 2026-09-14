# Exercises the real Terraform graph and input validation with provider effects
# mocked. This proves planning behavior, not live provider or tier isolation.
mock_provider "hcloud" {}
mock_provider "cloudflare" {}

variables {
  environment                  = "development"
  cloudflare_zone_id           = "00000000000000000000000000000001"
  eliza_app_zone_id            = "00000000000000000000000000000002"
  headscale_hostname           = "headscale-development.elizacloud.ai"
  canonical_headscale_hostname = "headscale-development.eliza.app"
  deploy_branch                = "develop"
}

run "development_creates_without_legacy_import" {
  command = plan

}

run "reject_production_canonical_headscale" {
  command = plan
  variables {
    canonical_headscale_hostname = "headscale.eliza.app"
  }
  expect_failures = [var.canonical_headscale_hostname]
}

run "reject_staging_legacy_headscale" {
  command = plan
  variables {
    headscale_hostname = "headscale-staging.elizacloud.ai"
  }
  expect_failures = [var.headscale_hostname]
}

run "reject_development_production_branch" {
  command = plan
  variables {
    deploy_branch = "main"
  }
  expect_failures = [var.deploy_branch]
}

run "reject_development_staging_branch" {
  command = plan
  variables {
    deploy_branch = "staging"
  }
  expect_failures = [var.deploy_branch]
}

# Exercise the branch-dependent server/cloud-init graph. Legacy DNS imports
# require existing provider state and are outside this branch-admission test.
run "staging_follows_staging" {
  command = plan
  plan_options {
    target = [hcloud_server.control_plane]
  }
  variables {
    environment                  = "staging"
    headscale_hostname           = "headscale-staging.elizacloud.ai"
    canonical_headscale_hostname = "headscale-staging.eliza.app"
    deploy_branch                = "staging"
  }
}

run "reject_staging_develop_branch" {
  command = plan
  plan_options {
    target = [hcloud_server.control_plane]
  }
  variables {
    environment                  = "staging"
    headscale_hostname           = "headscale-staging.elizacloud.ai"
    canonical_headscale_hostname = "headscale-staging.eliza.app"
    deploy_branch                = "develop"
  }
  expect_failures = [var.deploy_branch]
}
