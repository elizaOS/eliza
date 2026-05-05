# VPC Module for Gateway Discord Infrastructure

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.cluster_name}-vpc"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.cluster_name}-igw"
  }
}

# Public Subnets
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                        = "${var.cluster_name}-public-${count.index + 1}"
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

# Private Subnets
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name                                        = "${var.cluster_name}-private-${count.index + 1}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

# Public Route Table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.cluster_name}-public-rt"
  }
}

# Public Route Table Associations
resource "aws_route_table_association" "public" {
  count          = length(var.public_subnet_cidrs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# =============================================================================
# NAT Gateway Configuration (Default - managed, highly available)
# =============================================================================

# Elastic IPs for NAT Gateways - only when NOT using NAT Instance
resource "aws_eip" "nat_gateway" {
  count  = var.use_nat_instance ? 0 : (var.single_nat_gateway ? 1 : length(var.availability_zones))
  domain = "vpc"

  tags = {
    Name = "${var.cluster_name}-nat-eip-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# NAT Gateways - only when NOT using NAT Instance
resource "aws_nat_gateway" "main" {
  count         = var.use_nat_instance ? 0 : (var.single_nat_gateway ? 1 : length(var.availability_zones))
  allocation_id = aws_eip.nat_gateway[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "${var.cluster_name}-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.main]
}

# =============================================================================
# NAT Instance Configuration (Cost-effective alternative to NAT Gateway)
# =============================================================================

# Get the latest Amazon Linux 2023 AMI for NAT Instance
data "aws_ami" "nat_instance" {
  count       = var.use_nat_instance ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-kernel-*-arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

# Security Group for NAT Instance
resource "aws_security_group" "nat_instance" {
  count       = var.use_nat_instance ? 1 : 0
  name        = "${var.cluster_name}-nat-instance-sg"
  description = "Security group for NAT instance"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
    description = "Allow all traffic from VPC"
  }

  tags = {
    Name = "${var.cluster_name}-nat-instance-sg"
  }
}

# Elastic IP for NAT Instance
resource "aws_eip" "nat_instance" {
  count  = var.use_nat_instance ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "${var.cluster_name}-nat-instance-eip"
  }

  depends_on = [aws_internet_gateway.main]
}

# IAM Role for NAT Instance (for SSM access)
resource "aws_iam_role" "nat_instance" {
  count = var.use_nat_instance ? 1 : 0
  name  = "${var.cluster_name}-nat-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = {
    Name = "${var.cluster_name}-nat-instance-role"
  }
}

resource "aws_iam_role_policy_attachment" "nat_instance_ssm" {
  count      = var.use_nat_instance ? 1 : 0
  role       = aws_iam_role.nat_instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat_instance" {
  count = var.use_nat_instance ? 1 : 0
  name  = "${var.cluster_name}-nat-instance-profile"
  role  = aws_iam_role.nat_instance[0].name
}

# NAT Instance
resource "aws_instance" "nat" {
  count                = var.use_nat_instance ? 1 : 0
  ami                  = data.aws_ami.nat_instance[0].id
  instance_type        = var.nat_instance_type
  subnet_id            = aws_subnet.public[0].id
  source_dest_check    = false
  iam_instance_profile = aws_iam_instance_profile.nat_instance[0].name
  key_name             = var.nat_instance_key_name != "" ? var.nat_instance_key_name : null

  vpc_security_group_ids = [aws_security_group.nat_instance[0].id]

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -euo pipefail
    
    # Log output for debugging via SSM or cloud-init logs
    exec > >(tee /var/log/nat-setup.log) 2>&1
    echo "Starting NAT instance configuration..."
    
    # Disable Docker to prevent it from adding REJECT rules to iptables
    systemctl stop docker.socket docker.service 2>/dev/null || true
    systemctl disable docker.socket docker.service 2>/dev/null || true
    
    # Enable IP forwarding (idempotent)
    echo 1 > /proc/sys/net/ipv4/ip_forward
    if ! grep -q "^net.ipv4.ip_forward = 1" /etc/sysctl.conf; then
      echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
    fi
    sysctl -p
    
    # Detect primary network interface dynamically
    PRIMARY_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
    if [ -z "$PRIMARY_IFACE" ]; then
      echo "ERROR: Could not detect primary network interface"
      exit 1
    fi
    echo "Detected primary interface: $PRIMARY_IFACE"
    
    # Install iptables-services (dnf for AL2023, yum as fallback)
    if command -v dnf &> /dev/null; then
      dnf install -y iptables-services
    else
      yum install -y iptables-services
    fi
    
    # Stop iptables service to prevent it from loading default rules
    systemctl stop iptables 2>/dev/null || true
    
    # Remove any default iptables config that may have REJECT rules
    rm -f /etc/sysconfig/iptables
    
    # Completely flush all iptables rules to start clean
    iptables -F
    iptables -X
    iptables -t nat -F
    iptables -t nat -X
    iptables -t mangle -F
    iptables -t mangle -X
    
    # Set permissive default policies
    iptables -P INPUT ACCEPT
    iptables -P FORWARD ACCEPT
    iptables -P OUTPUT ACCEPT
    
    # Set up NAT masquerading for VPC traffic
    iptables -t nat -A POSTROUTING -o "$PRIMARY_IFACE" -s ${var.vpc_cidr} -j MASQUERADE
    
    # Save iptables BEFORE starting the service (creates clean config file)
    mkdir -p /etc/sysconfig
    iptables-save > /etc/sysconfig/iptables
    
    # Now enable and start iptables (will load our clean config)
    systemctl enable iptables
    systemctl start iptables
    
    echo "NAT instance configuration completed successfully"
  EOF
  )

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30 # AL2023 AMI requires minimum 30GB
    delete_on_termination = true
    encrypted             = true
  }

  tags = {
    Name = "${var.cluster_name}-nat-instance"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

# Associate Elastic IP with NAT Instance
resource "aws_eip_association" "nat_instance" {
  count         = var.use_nat_instance ? 1 : 0
  instance_id   = aws_instance.nat[0].id
  allocation_id = aws_eip.nat_instance[0].id
}

# =============================================================================
# Private Route Tables
# =============================================================================

# Private Route Tables
resource "aws_route_table" "private" {
  count  = length(var.availability_zones)
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.cluster_name}-private-rt-${count.index + 1}"
  }
}

# Route to NAT Gateway (when NOT using NAT Instance)
resource "aws_route" "private_nat_gateway" {
  count                  = var.use_nat_instance ? 0 : length(var.availability_zones)
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

# Route to NAT Instance (when using NAT Instance)
resource "aws_route" "private_nat_instance" {
  count                  = var.use_nat_instance ? length(var.availability_zones) : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat[0].primary_network_interface_id
}

# Private Route Table Associations
resource "aws_route_table_association" "private" {
  count          = length(var.private_subnet_cidrs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# =============================================================================
# VPC Endpoint for S3 (Gateway endpoint - free)
# =============================================================================

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.id}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = {
    Name = "${var.cluster_name}-vpce-s3"
  }
}

data "aws_region" "current" {}
