#!/bin/bash
# Teardown a single user's CloudFormation stack
# Usage: ./teardown-user-stack.sh <userId>

set -e

# Auto-load from .env.local if variables not set
if [ -z "$AWS_REGION" ]; then
  if [ -f "../../.env.local" ]; then
    echo "📝 Loading environment variables from .env.local..."
    echo ""
    source load-env.sh
  fi
fi

USER_ID="$1"
REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"

if [ -z "$USER_ID" ]; then
  echo "❌ Error: USER_ID required"
  echo "Usage: $0 <userId>"
  exit 1
fi

STACK_NAME="elizaos-user-${USER_ID}"

echo "🗑️  Tearing down CloudFormation stack: $STACK_NAME"
echo "Region: $REGION"
echo "Environment: $ENVIRONMENT"
echo ""

# Check if stack exists
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" &>/dev/null; then
  echo "❌ Stack $STACK_NAME does not exist"
  exit 1
fi

# Get stack resources before deletion for logging
echo "📋 Stack resources to be deleted:"
aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'StackResources[*].[LogicalResourceId,ResourceType,ResourceStatus]' \
  --output table

echo ""
read -p "⚠️  Are you sure you want to delete this stack? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

# Delete stack
echo "🗑️  Initiating stack deletion..."
aws cloudformation delete-stack \
  --stack-name "$STACK_NAME" \
  --region "$REGION"

echo "⏳ Waiting for stack deletion to complete (this may take 5-10 minutes)..."
aws cloudformation wait stack-delete-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION"

echo ""
echo "✅ Stack $STACK_NAME deleted successfully!"
echo ""
echo "🧹 Next steps:"
echo "1. ALB priority will be auto-released and cleaned up within 24 hours"
echo "2. Verify no orphaned EBS volumes:"
echo "   aws ec2 describe-volumes --filters \"Name=tag:UserId,Values=$USER_ID\" --region $REGION"
echo "3. Check CloudWatch logs for any errors:"
echo "   aws logs tail /ecs/elizaos-user-$USER_ID --follow --region $REGION"
