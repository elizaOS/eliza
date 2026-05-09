variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
}

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
}

variable "use_nat_instance" {
  description = "Use NAT Instance instead of NAT Gateway (cost saving for non-prod)"
  type        = bool
  default     = false
}

variable "nat_instance_type" {
  description = "Instance type for NAT instance (t4g.nano for development, t4g.micro for production)"
  type        = string
  default     = "t4g.nano"
}

variable "nat_instance_key_name" {
  description = <<-EOT
    EC2 key pair name for SSH access to NAT Instance (optional).
    
    Default: "" (empty) - No SSH key attached, access via SSM Session Manager only.
    This is the recommended secure approach as it avoids managing SSH keys.
    
    To enable SSH access, create an EC2 key pair and pass its name here.
    Note: Security group already allows traffic from VPC CIDR.
  EOT
  type        = string
  default     = ""
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway/instance for all AZs (cost savings, less redundancy)"
  type        = bool
  default     = true
}
