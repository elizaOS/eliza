#!/bin/bash
# Teardown ALL user CloudFormation stacks (DANGEROUS - USE WITH CAUTION!)
# Usage: ./teardown-all-user-stacks.sh --force

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
FORCE="$1"

if [ "$FORCE" != "--force" ]; then
  echo "❌ This will delete ALL user container stacks!"
  echo "Usage: $0 --force"
  exit 1
fi

echo "🗑️  Finding all ElizaOS user stacks..."

# Get all user stacks
STACKS=$(aws cloudformation list-stacks \
  --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?starts_with(StackName, `elizaos-user-`)].StackName' \
  --output text)

STACK_COUNT=$(echo "$STACKS" | wc -w | tr -d ' ')

echo "Found $STACK_COUNT user stacks"
echo ""
echo "$STACKS" | tr ' ' '\n'
echo ""
read -p "⚠️  Delete all $STACK_COUNT stacks? Type 'DELETE ALL' to confirm: " CONFIRM

if [ "$CONFIRM" != "DELETE ALL" ]; then
  echo "Cancelled."
  exit 0
fi

# Delete all stacks in parallel
echo "🗑️  Initiating deletion of all $STACK_COUNT stacks..."
for STACK in $STACKS; do
  echo "Deleting $STACK..."
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" &
  
  # Add small delay to avoid API throttling
  sleep 0.5
done

echo "⏳ Waiting for all deletions to complete..."
echo "This will take approximately 10-15 minutes"
echo ""

# Wait for all background jobs to complete
wait

echo ""
echo "✅ All stack deletions initiated!"
echo ""
echo "🧹 Post-cleanup tasks:"
echo "1. Run cleanup script to remove orphaned resources:"
echo "   bun run scripts/cleanup-orphaned-stacks.ts"
echo "2. Verify all EBS volumes are deleted:"
echo "   aws ec2 describe-volumes --filters \"Name=tag:BillingEntity,Values=ElizaOS\" --region $REGION"
echo "3. Check for any failed deletions:"
echo "   aws cloudformation list-stacks --stack-status-filter DELETE_FAILED --region $REGION | grep elizaos-user"

