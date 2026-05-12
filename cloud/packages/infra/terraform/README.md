# Package Infra Terraform

This package-level Terraform root is no longer an active Gateway Discord deployment source.

- Canonical Gateway Discord AWS Terraform lives in `cloud/services/gateway-discord/terraform` and is what CI uses.
- The previous package-level AWS copy is quarantined in `legacy-gateway-discord-aws/` for audit/reference only.
- The `gcp/` roots are partial and are not wired to any CI workflow found in this repository. Treat them as experimental until a consumer is added and documented.

Do not run Terraform from this directory expecting Gateway Discord AWS infrastructure to change.

## Quarantined Gateway Discord Terraform Infrastructure

This Terraform configuration provisions the AWS infrastructure required for the Discord Gateway service.

## Infrastructure Components

- **VPC**: Virtual Private Cloud with public and private subnets across 3 availability zones (custom module)
- **NAT Instance**: Cost-effective NAT using t4g.nano/micro EC2 instances (ARM64)
  - Development: Single t4g.nano (~$3/month)
  - Production: Single t4g.micro (~$6/month)
  - Can be switched to NAT Gateway for high-traffic scenarios (see Cost Considerations)
- **EKS Cluster**: Kubernetes cluster using [terraform-aws-modules/eks/aws](https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest) official module
  - KMS encryption for secrets
  - CloudWatch logging enabled
  - OIDC provider for IRSA (IAM Roles for Service Accounts)
  - EKS Access API for cluster authentication
- **Node Groups**: EC2 instances managed by EKS for running pods
- **IAM Roles**: 
  - EKS cluster role (managed by official module)
  - Node group role (managed by official module)
  - NAT instance role (with SSM access)
  - GitHub Actions OIDC role for CI/CD
- **Security Groups**: Network security for cluster, nodes, and NAT instance
- **Kubernetes Resources**:
  - Namespace for gateway-discord
  - GHCR image pull secrets
  - Application secrets
  - RBAC for GitHub Actions CI/CD

## Prerequisites

### Required Tools
1. AWS CLI configured with appropriate credentials
2. Terraform >= 1.5.0
3. kubectl (for interacting with the cluster after creation)
4. Helm (for deploying the gateway-discord chart)

### Required AWS Resources (Before First `terraform init`)

The Terraform backend requires an S3 bucket and DynamoDB table to exist before you can initialize Terraform. These are used to store state files and prevent concurrent modifications.

| Resource | Name | Purpose |
|----------|------|---------|
| S3 Bucket | `eliza-cloud-terraform-state` | Stores Terraform state files |
| DynamoDB Table | `terraform-state-lock` | Prevents concurrent state modifications |

**See [One-Time Setup](#1-create-s3-backend) below for creation commands.**

> **Note**: If these resources don't exist, `terraform init` will fail with an error like:
> `Error: Failed to get existing workspaces: S3 bucket does not exist.`

## Directory Structure

```
services/gateway-discord/terraform/
├── main.tf                    # Main configuration (uses official EKS module)
├── variables.tf               # Input variables
├── variables-sensitive.tf     # Sensitive input variables
├── outputs.tf                 # Output values
├── providers.tf               # Provider configuration
├── versions.tf                # Required versions
├── tfvars/
│   ├── development.tfvars     # Development environment values
│   ├── production.tfvars      # Production environment values
│   └── secrets.tfvars.example # Example secrets file
├── backend-development.hcl    # Backend config for development
├── backend-production.hcl     # Backend config for production
└── modules/
    ├── vpc/                   # VPC module (custom - supports NAT Instance)
    ├── github-oidc/           # GitHub OIDC module (custom)
    └── k8s-resources/         # Kubernetes resources module
```

> **Note**: The EKS cluster is provisioned using the official [terraform-aws-modules/eks/aws](https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest) module (v20.x). Custom modules are only used where official modules don't meet requirements (VPC with NAT Instance support, project-specific GitHub OIDC configuration).

## Usage

> **Note**: Infrastructure is managed via a unified GitHub Actions workflow (`.github/workflows/gateway-discord.yml`).
> The workflow auto-detects terraform vs app changes and runs appropriate jobs in sequence:
> - **Push to `dev`** → Terraform apply + app deploy to development
> - **Push to `main`** → Terraform apply + app deploy to production
> - **Pull Requests** → Terraform plan + tests only (no apply/deploy)
> - **Manual dispatch** → Run terraform-plan/terraform-apply/terraform-destroy/deploy on demand
>
> If both terraform and app files change, terraform runs first, then deploy waits for completion.
>
> You only need to complete the **One-Time Setup** below before the workflow can run.

### One-Time Setup

#### 1. Create S3 Backend

Before the GitHub Actions workflow can run, create an S3 bucket and DynamoDB table for state storage. A single bucket is shared by both development and production - environments are separated by key prefix.

```bash
# Create S3 bucket for state (shared by all environments)
aws s3api create-bucket \
  --bucket eliza-cloud-terraform-state \
  --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket eliza-cloud-terraform-state \
  --versioning-configuration Status=Enabled

# Enable server-side encryption (Terraform state contains sensitive data)
aws s3api put-bucket-encryption \
  --bucket eliza-cloud-terraform-state \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Create DynamoDB table for state locking (shared by all environments)
aws dynamodb create-table \
  --table-name terraform-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

**Cost**: S3 + DynamoDB = ~$0/month (state files are tiny, lock operations are rare)

#### 2. Create AWS OIDC Role for GitHub Actions (Optional)

For the GitHub Actions IaC workflow to run, you need an IAM role that trusts GitHub OIDC. This is a one-time manual setup.

> **Alternative**: Skip this step and run Terraform locally using your own AWS credentials. The IaC workflow is optional - you can manage infrastructure locally and only use GitHub Actions for app deployments.

<details>
<summary><strong>Step 2a: Create OIDC Identity Provider</strong></summary>

```bash
# Create the GitHub OIDC provider in your AWS account
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd
```

Or via AWS Console: **IAM → Identity providers → Add provider** (OpenID Connect)
</details>

<details>
<summary><strong>Step 2b: Create IAM Role for Terraform</strong></summary>

Create a file `terraform-role-trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:elizaOS/cloud:ref:refs/heads/main",
            "repo:elizaOS/cloud:ref:refs/heads/develop",
            "repo:elizaOS/cloud:ref:refs/heads/feat/*",
            "repo:elizaOS/cloud:pull_request",
            "repo:elizaOS/cloud:environment:gateway-dev",
            "repo:elizaOS/cloud:environment:gateway-prd"
          ]
        }
      }
    }
  ]
}
```

> **Note**: The `pull_request` and `feat/*` subjects allow PRs and feature branches to run Terraform plan. GitHub uses different OIDC subject formats for different event types. Ensure the org name case matches exactly (`elizaOS` not `elizaos`).

To update an existing role's trust policy:
```bash
aws iam update-assume-role-policy \
  --role-name github-actions-gateway-terraform \
  --policy-document file://terraform-role-trust-policy.json
```

Create the role and attach the custom policy:

```bash
# Replace YOUR_ACCOUNT_ID in the JSON file first
aws iam create-role \
  --role-name github-actions-gateway-terraform \
  --assume-role-policy-document file://terraform-role-trust-policy.json

# Create custom policy with least-privilege permissions (see terraform-iam-policy.json below)
aws iam create-policy \
  --policy-name gateway-terraform-policy \
  --policy-document file://terraform-iam-policy.json

# Attach the custom policy. Replace YOUR_ACCOUNT_ID
aws iam attach-role-policy \
  --role-name github-actions-gateway-terraform \
  --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/gateway-terraform-policy
```

<details>
<summary>terraform-iam-policy.json (Compact Policy - fits within 6144 char limit)</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2Full",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "ec2:Get*",
        "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute",
        "ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway",
        "ec2:CreateNatGateway", "ec2:DeleteNatGateway",
        "ec2:AllocateAddress", "ec2:ReleaseAddress", "ec2:AssociateAddress", "ec2:DisassociateAddress",
        "ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute", "ec2:ReplaceRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable",
        "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroup*", "ec2:RevokeSecurityGroup*", "ec2:ModifySecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptions*",
        "ec2:CreateVpcEndpoint", "ec2:DeleteVpcEndpoints", "ec2:ModifyVpcEndpoint",
        "ec2:CreateTags", "ec2:DeleteTags",
        "ec2:RunInstances", "ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceCreditSpecification",
        "ec2:CreateVolume", "ec2:DeleteVolume", "ec2:AttachVolume", "ec2:DetachVolume",
        "ec2:CreateLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:ModifyLaunchTemplate",
        "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:ModifyNetworkInterfaceAttribute"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSFull",
      "Effect": "Allow",
      "Action": ["eks:*"],
      "Resource": "*"
    },
    {
      "Sid": "AutoScaling",
      "Effect": "Allow",
      "Action": ["autoscaling:*"],
      "Resource": "*"
    },
    {
      "Sid": "IAMManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:ListRole*",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies",
        "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile",
        "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:ListInstanceProfile*",
        "iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider", "iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviders", "iam:TagOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy*", "iam:ListPolic*", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
        "iam:CreateServiceLinkedRole", "iam:DeleteServiceLinkedRole", "iam:PassRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "KMSManagement",
      "Effect": "Allow",
      "Action": [
        "kms:Create*", "kms:Delete*", "kms:Describe*", "kms:Get*", "kms:List*", "kms:Tag*", "kms:Untag*",
        "kms:Enable*", "kms:Disable*", "kms:Schedule*", "kms:Cancel*",
        "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:*Grant"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": ["logs:*"],
      "Resource": "*"
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity", "sts:AssumeRole", "sts:TagSession"],
      "Resource": "*"
    },
    {
      "Sid": "TerraformState",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucket*"],
      "Resource": ["arn:aws:s3:::eliza-cloud-terraform-state", "arn:aws:s3:::eliza-cloud-terraform-state/*"]
    },
    {
      "Sid": "TerraformLock",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"],
      "Resource": "arn:aws:dynamodb:*:*:table/terraform-state-lock"
    },
    {
      "Sid": "SSM",
      "Effect": "Allow",
      "Action": ["ssm:Describe*", "ssm:GetParameter*"],
      "Resource": "*"
    }
  ]
}
```
</details>

The role ARN will be: `arn:aws:iam::YOUR_ACCOUNT_ID:role/github-actions-gateway-terraform`
</details>

> **Security Note**: The custom policy above follows the principle of least privilege, granting only the permissions required to create VPCs, EKS clusters, IAM roles, and supporting resources. After Terraform runs, it creates a separate `github-actions-gateway-dev/prd` role with limited EKS-only permissions for app deployments.

<details>
<summary><strong>Step 2c: Gateway Deployment Role (github-actions-gateway-dev/prd)</strong></summary>

This role is used by the **deploy** job to access EKS and deploy Helm charts. It's created by Terraform's `github-oidc` module, but if you have `create_github_actions_role = false` in your tfvars, you need to manage the trust policy manually.

**Trust Policy**: Use the same `terraform-role-trust-policy.json` from Step 2b above.

**Update existing role's trust policy:**

```bash
# For development environment
aws iam update-assume-role-policy \
  --role-name github-actions-gateway-dev \
  --policy-document file://terraform-role-trust-policy.json

# For production environment
aws iam update-assume-role-policy \
  --role-name github-actions-gateway-prd \
  --policy-document file://terraform-role-trust-policy.json
```

> **Note**: When `create_github_actions_role = false`, Terraform only looks up the role ARN via data source and won't modify the trust policy. You must update it manually if adding new branch patterns.

</details>

#### 3. Configure GitHub Environments

Create two GitHub Environments (`gateway-dev` and `gateway-prd`) in your repository settings with the following:

**Variables** (Settings → Environments → [environment] → Environment variables):
- `TERRAFORM_AWS_ROLE_ARN`: IAM role for Terraform operations (e.g., `arn:aws:iam::YOUR_ACCOUNT_ID:role/github-actions-gateway-terraform`)
- `GATEWAY_AWS_ROLE_ARN`: IAM role for EKS/Helm deployments (e.g., `arn:aws:iam::YOUR_ACCOUNT_ID:role/github-actions-gateway-dev`)
- `AWS_REGION`: `us-east-1`
- `CLUSTER_NAME`: EKS cluster name (e.g., `gateway-cluster-dev`)

**Secrets** (Settings → Environments → [environment] → Environment secrets):
- `GHCR_USERNAME`: GitHub Container Registry username
- `GHCR_TOKEN`: GitHub Container Registry token (PAT with `read:packages`)
- `ELIZA_CLOUD_URL`: Eliza Cloud API URL
- `GATEWAY_BOOTSTRAP_SECRET`: Gateway bootstrap secret
- `REDIS_URL`: Redis connection URL
- `REDIS_TOKEN`: Redis authentication token
- `BLOB_TOKEN`: Blob storage token
- `ELIZA_APP_DISCORD_BOT_TOKEN`: Discord bot token for the Eliza App system bot (DM-based interactions)
- `ELIZA_APP_DISCORD_APPLICATION_ID`: Discord application ID for the Eliza App system bot

### Post-Deployment

#### Configure kubectl

After the cluster is created, configure kubectl to access it:

```bash
# For development
aws eks update-kubeconfig --name gateway-cluster-dev --region us-east-1

# For production
aws eks update-kubeconfig --name gateway-cluster-prod --region us-east-1
```

---

### Local Terraform (Recommended)

Running Terraform locally is the simplest approach - no need to set up `TERRAFORM_AWS_ROLE_ARN` or GitHub OIDC for infrastructure.

**Prerequisites:**
- AWS CLI configured with credentials (`aws configure` or `aws sso login`)
- Your AWS user/role needs permissions to create VPCs, EKS, IAM roles, etc.

#### Configure AWS Credentials

If using AWS profiles (recommended), export credentials to environment variables before running terraform:

```bash
# Export credentials from your AWS profile to environment variables
eval "$(aws configure export-credentials --profile YOUR_PROFILE_NAME --format env)"

# Verify credentials are set
aws sts get-caller-identity
```

This ensures terraform uses the correct AWS account and credentials.

#### Initialize Terraform

```bash
cd services/gateway-discord/terraform

# For development
terraform init -backend-config=backend-development.hcl

# For production
terraform init -backend-config=backend-production.hcl -reconfigure
```

#### Create Secrets File

```bash
cp tfvars/secrets.tfvars.example tfvars/secrets.tfvars
# Edit tfvars/secrets.tfvars with actual values
```

#### Plan and Apply

```bash
# For development
terraform plan -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars
terraform apply -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars

# For production
terraform plan -var-file=tfvars/production.tfvars -var-file=tfvars/secrets.tfvars
terraform apply -var-file=tfvars/production.tfvars -var-file=tfvars/secrets.tfvars
```

#### Phased Deployment (Large Infrastructure)

For initial deployment or debugging, you can deploy in phases:

```bash
# Phase 1: VPC and EKS
terraform apply -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars \
  -target=module.vpc \
  -target=module.eks

# Phase 2: GitHub OIDC
terraform apply -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars \
  -target=module.github_oidc

# Phase 3: Kubernetes resources
terraform apply -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars
```

## Outputs

After applying, Terraform outputs:

| Output | Description |
|--------|-------------|
| `cluster_name` | EKS cluster name |
| `cluster_endpoint` | Kubernetes API server endpoint |
| `github_actions_role_arn` | IAM role ARN for GitHub Actions |
| `kubeconfig_command` | Command to configure kubectl |
| `github_actions_variables` | All variables needed for GitHub Actions |

## Destroying Infrastructure

```bash
# CAUTION: This will destroy all resources
terraform destroy -var-file=tfvars/development.tfvars -var-file=tfvars/secrets.tfvars
```

## Security Notes

1. Never commit `secrets.tfvars` to version control
2. The S3 state bucket should have encryption enabled
3. Use IAM roles with least-privilege access
4. GitHub OIDC is used instead of long-lived credentials

## Cost Considerations

- **EKS Control Plane**: ~$72/month
- **NAT**:
  - NAT Gateway: ~$32/month per gateway + $0.045/GB data
  - NAT Instance (t4g.nano): ~$3/month (development) - significant cost savings
- **EC2 Instances (EKS nodes)**: Varies by instance type and count
- **Data Transfer**: Varies by usage

### NAT Instance vs NAT Gateway

The infrastructure supports both NAT Gateway and NAT Instance. Configure via `use_nat_instance` variable:

```hcl
# Default: NAT Instance for cost savings (both development and production)
use_nat_instance   = true
nat_instance_type  = "t4g.nano"   # development (~$3/month)
nat_instance_type  = "t4g.micro"  # production (~$6/month)

# High-traffic: Switch to NAT Gateway
use_nat_instance   = false
```

| Feature | NAT Gateway | NAT Instance (t4g.nano/micro) |
|---------|-------------|------------------------------|
| Cost | ~$32/month + data | ~$3-6/month + data |
| Bandwidth | Up to 100 Gbps | Up to 5 Gbps (burst) |
| Availability | Managed, HA | Single instance (can fail) |
| Maintenance | None | OS updates, monitoring |
| Best for | High-traffic, mission-critical | Low-moderate traffic, cost-sensitive |

#### When to Use NAT Gateway

Switch to NAT Gateway (`use_nat_instance = false`) if:

1. **High outbound traffic** (>5 Gbps sustained) - NAT Instance bandwidth limit reached
2. **Mission-critical workloads** - Cannot tolerate any NAT downtime
3. **Compliance requirements** - Need AWS-managed, auditable infrastructure
4. **Multi-AZ redundancy** - Need NAT per AZ for HA (set `single_nat_gateway = false`)

#### When NAT Instance is Sufficient

NAT Instance is recommended for:

1. **Discord gateway workloads** - I/O bound, low bandwidth (websockets + API calls)
2. **Development environments** - Cost optimization priority
3. **Low-moderate traffic production** - <1 Gbps sustained outbound traffic
4. **Cost-sensitive deployments** - Saves ~$26-29/month per NAT

**Note**: For Discord gateway specifically, traffic is primarily:
- Inbound websocket connections (not through NAT)
- Outbound API calls to the eliza-cloud API (low bandwidth)

This makes NAT Instance ideal for this workload even in production.
