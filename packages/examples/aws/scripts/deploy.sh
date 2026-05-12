#!/bin/bash
# Deploy elizaOS AWS Lambda worker (TypeScript)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(dirname "$SCRIPT_DIR")"
cd "$AWS_DIR"

echo "🚀 Deploying elizaOS AWS Lambda Worker (TypeScript)"
echo ""

command -v sam >/dev/null 2>&1 || { echo "❌ SAM CLI is required. Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI is required. Install: https://aws.amazon.com/cli/"; exit 1; }

if [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ OPENAI_API_KEY environment variable is required"
    exit 1
fi

echo "📦 Installing dependencies..."
bun install

echo "📦 Building (SAM)..."
sam build

echo ""
echo "🌩️  Deploying to AWS..."
sam deploy \
    --parameter-overrides \
        OpenAIApiKey="$OPENAI_API_KEY" \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Get your API endpoint:"
echo "   aws cloudformation describe-stacks --stack-name eliza-worker --query 'Stacks[0].Outputs[?OutputKey==\`ChatEndpoint\`].OutputValue' --output text"
