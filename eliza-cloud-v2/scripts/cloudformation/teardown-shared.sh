#!/bin/bash
# Teardown ElizaOS Shared Infrastructure
# WARNING: This will affect ALL users. Only run when shutting down the entire platform.

set -e

# Auto-load from .env.local if variables not set
if [ -z "$AWS_REGION" ]; then
  if [ -f "../../.env.local" ]; then
    echo "📝 Loading environment variables from .env.local..."
    echo ""
    source load-env.sh
  fi
fi

REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-production}"
STACK_NAME="${ENVIRONMENT}-elizaos-shared"

echo "⚠️  WARNING: Teardown Shared Infrastructure"
echo "==========================================="
echo "This will delete the shared VPC, ALB, and IAM roles."
echo "ALL user stacks will lose connectivity!"
echo ""
echo "Stack: $STACK_NAME"
echo "Region: $REGION"
echo ""
read -p "Are you sure you want to continue? (type 'DELETE' to confirm): " CONFIRM

if [ "$CONFIRM" != "DELETE" ]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "🗑️  Deleting shared infrastructure..."
echo ""

# Delete stack
aws cloudformation delete-stack \
  --stack-name "$STACK_NAME" \
  --region "$REGION"

echo "⏳ Waiting for stack deletion (this may take 10 minutes)..."
aws cloudformation wait stack-delete-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION"

echo ""
echo "✅ Shared infrastructure deleted successfully"
echo ""

