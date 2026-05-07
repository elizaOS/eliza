provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Project     = var.project_name
        Environment = var.environment
        ManagedBy   = "terraform"
      },
      var.tags
    )
  }
}

provider "kubernetes" {
  host                   = try(module.eks.cluster_endpoint, null)
  cluster_ca_certificate = try(base64decode(module.eks.cluster_certificate_authority_data), null)

  exec {
    api_version = "client.authentication.k8s.io/v1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", try(module.eks.cluster_name, "")]
  }
}

provider "helm" {
  kubernetes {
    host                   = try(module.eks.cluster_endpoint, null)
    cluster_ca_certificate = try(base64decode(module.eks.cluster_certificate_authority_data), null)

    exec {
      api_version = "client.authentication.k8s.io/v1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", try(module.eks.cluster_name, "")]
    }
  }
}
