#!/bin/bash
# Deploy ElizaOS Shared Infrastructure v2 (Production Ready)
# VPC, ALB, IAM Roles - Deploy this ONCE before any user deployments

set -e

# Auto-load from .env.local if variables not set
if [ -z "$AWS_REGION" ] || [ -z "$ACM_CERTIFICATE_ARN" ]; then
  if [ -f "../../.env.local" ]; then
    echo "📝 Loading environment variables from .env.local..."
    echo ""
    source load-env.sh
  fi
fi

REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"
CERTIFICATE_ARN="${ACM_CERTIFICATE_ARN}"

echo "🚀 ElizaOS Shared Infrastructure Deployment v2 (Production Ready)"
echo "=================================================================="
echo "Region: $REGION"
echo "Environment: $ENVIRONMENT"
echo ""

# Validate required parameters
if [ -z "$CERTIFICATE_ARN" ]; then
  echo "❌ Error: ACM_CERTIFICATE_ARN environment variable is required"
  echo "   Create an ACM certificate for *.containers.elizacloud.ai first:"
  echo "   aws acm request-certificate --domain-name '*.containers.elizacloud.ai' --validation-method DNS --region $REGION"
  exit 1
fi

STACK_NAME="${ENVIRONMENT}-elizaos-shared"
TEMPLATE_FILE="shared-infrastructure.json"

# Check if template exists
if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "❌ Error: Template not found: $TEMPLATE_FILE"
  echo "   Ensure you're in the infrastructure/cloudformation directory"
  exit 1
fi

echo "📡 Deploying shared infrastructure stack: $STACK_NAME"
echo "   Using template: $TEMPLATE_FILE"
echo ""

# Check if stack already exists
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" &>/dev/null; then
  echo "⚠️  Stack $STACK_NAME already exists!"
  echo ""
  echo "Options:"
  echo "1. Update existing stack (may cause downtime)"
  echo "2. Delete and recreate (DANGER: will delete all user containers)"
  echo "3. Cancel"
  echo ""
  read -p "Choose option (1/2/3): " OPTION
  
  case $OPTION in
    1)
      echo "📝 Updating existing stack..."
      aws cloudformation update-stack \
        --stack-name "$STACK_NAME" \
        --template-body "file://$TEMPLATE_FILE" \
        --parameters \
          ParameterKey=Environment,ParameterValue="$ENVIRONMENT" \
          ParameterKey=CertificateArn,ParameterValue="$CERTIFICATE_ARN" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --tags Key=Project,Value=ElizaOS Key=ManagedBy,Value=CloudFormation Key=Version,Value=v2
      
      echo "⏳ Waiting for stack update to complete..."
      aws cloudformation wait stack-update-complete \
        --stack-name "$STACK_NAME" \
        --region "$REGION"
      ;;
    2)
      echo "🗑️  Deleting existing stack..."
      aws cloudformation delete-stack \
        --stack-name "$STACK_NAME" \
        --region "$REGION"
      
      echo "⏳ Waiting for deletion..."
      aws cloudformation wait stack-delete-complete \
        --stack-name "$STACK_NAME" \
        --region "$REGION"
      
      echo "📝 Creating new stack..."
      aws cloudformation create-stack \
        --stack-name "$STACK_NAME" \
        --template-body "file://$TEMPLATE_FILE" \
        --parameters \
          ParameterKey=Environment,ParameterValue="$ENVIRONMENT" \
          ParameterKey=CertificateArn,ParameterValue="$CERTIFICATE_ARN" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --tags Key=Project,Value=ElizaOS Key=ManagedBy,Value=CloudFormation Key=Version,Value=v2
      ;;
    *)
      echo "Cancelled."
      exit 0
      ;;
  esac
else
  # Create new stack
  echo "📝 Creating new shared infrastructure stack..."
  aws cloudformation create-stack \
    --stack-name "$STACK_NAME" \
    --template-body "file://$TEMPLATE_FILE" \
    --parameters \
      ParameterKey=Environment,ParameterValue="$ENVIRONMENT" \
      ParameterKey=CertificateArn,ParameterValue="$CERTIFICATE_ARN" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$REGION" \
    --tags Key=Project,Value=ElizaOS Key=ManagedBy,Value=CloudFormation Key=Version,Value=v2

  echo "⏳ Waiting for stack to complete (this may take 5-10 minutes)..."
  aws cloudformation wait stack-create-complete \
    --stack-name "$STACK_NAME" \
    --region "$REGION"
fi

echo ""
echo "✅ Shared infrastructure deployed successfully!"
echo ""

# Get outputs
echo "📋 Stack Outputs:"
echo "================="
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table

echo ""
echo "🎯 Next Steps:"
echo "1. Save the ALB DNS name and update your DNS:"
echo "   *.containers.elizacloud.ai → CNAME → <ALB DNS>"
echo "2. Verify DNS propagation: dig $(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs[?OutputKey==`SharedALBDNS`].OutputValue' --output text)"
echo "3. Update your eliza-cloud-v2/.env file with the outputs above"
echo "4. Users can now run 'elizaos deploy' to get their own EC2 instance"
echo ""
echo "💰 Cost Estimate:"
echo "   - Application Load Balancer: ~\$16/month (fixed)"
echo "   - Data transfer: ~\$5/month (varies by traffic)"
echo "   - Total shared cost: ~\$21/month (shared across all users)"
echo ""
echo "🔧 What was deployed (v2 improvements):"
echo "   ✅ VPC with 2 public subnets"
echo "   ✅ Application Load Balancer (60s idle timeout for cost savings)"
echo "   ✅ HTTPS listener with your ACM certificate"
echo "   ✅ HTTP→HTTPS redirect"
echo "   ✅ IAM roles with ECR describe permissions"
echo "   ✅ Comprehensive billing tags"
echo "   ✅ Production-ready security settings"
echo ""

