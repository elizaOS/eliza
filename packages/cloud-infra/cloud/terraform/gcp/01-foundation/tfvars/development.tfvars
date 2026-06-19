project_id  = "development-env-soulmates-land"
environment = "development"
region      = "us-east1"

cluster_name        = "elizaos-dev"
deletion_protection = false

master_authorized_cidrs = [
  {
    cidr_block   = "0.0.0.0/0"
    display_name = "All"
  }
]

github_repos = ["elizaOS/cloud"]
