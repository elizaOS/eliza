#!/bin/bash
# Load environment variables from .env.local for CloudFormation deployments
# Usage: source load-env.sh

ENV_FILE="../../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Error: .env.local not found at $ENV_FILE"
  echo "   Please create .env.local file in project root"
  echo "   Copy from example.env.local and fill in your values"
  exit 1
fi

echo "📝 Loading environment variables from .env.local..."

# Read .env.local and export variables
# Skip comments and empty lines
while IFS='=' read -r key value; do
  # Skip comments and empty lines
  if [[ "$key" =~ ^#.*$ ]] || [[ -z "$key" ]]; then
    continue
  fi
  
  # Remove leading/trailing whitespace
  key=$(echo "$key" | xargs)
  value=$(echo "$value" | xargs)
  
  # Remove quotes from value if present
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  
  # Export the variable
  if [[ -n "$key" ]] && [[ -n "$value" ]]; then
    export "$key=$value"
    echo "  ✓ Loaded: $key"
  fi
done < "$ENV_FILE"

echo ""
echo "✅ Environment variables loaded!"
echo ""
echo "Required for CloudFormation deployment:"
echo "  AWS_REGION: ${AWS_REGION:-❌ Not set}"
echo "  AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:+✓ Set}"
echo "  AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:+✓ Set}"
echo "  ACM_CERTIFICATE_ARN: ${ACM_CERTIFICATE_ARN:-❌ Not set}"
echo "  ENVIRONMENT: ${ENVIRONMENT:-production}"
echo ""


