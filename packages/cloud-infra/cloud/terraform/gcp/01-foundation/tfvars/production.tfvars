project_id  = "REPLACE_WITH_PROJECT_ID"
environment = "production"
region      = "us-east1"

cluster_name        = "elizaos-prod"
deletion_protection = true

master_authorized_cidrs = [
  # Restrict to known IPs in production
  # {
  #   cidr_block   = "x.x.x.x/32"
  #   display_name = "VPN"
  # }
]

github_repos = ["elizaOS/cloud"]
