output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "nat_gateway_ids" {
  description = "NAT Gateway IDs (empty if using NAT Instance)"
  value       = aws_nat_gateway.main[*].id
}

output "nat_instance_ids" {
  description = "NAT Instance IDs (empty if using NAT Gateway)"
  value       = aws_instance.nat[*].id
}

output "nat_public_ips" {
  description = "NAT public IPs (Gateway or Instance)"
  value       = var.use_nat_instance ? aws_eip.nat_instance[*].public_ip : aws_eip.nat_gateway[*].public_ip
}

output "internet_gateway_id" {
  description = "Internet Gateway ID"
  value       = aws_internet_gateway.main.id
}
