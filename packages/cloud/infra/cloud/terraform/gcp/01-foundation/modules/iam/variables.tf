variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "github_repos" {
  description = "GitHub repos allowed to deploy (e.g. [\"elizaOS/eliza\"])"
  type        = list(string)
}
