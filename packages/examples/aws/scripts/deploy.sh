#!/bin/bash
# Deploy elizaOS AWS Lambda worker
# Usage: ./scripts/deploy.sh [typescript|python|rust]

set -e

RUNTIME="${1:-typescript}"

echo "🚀 Deploying elizaOS AWS Lambda Worker"
echo "📦 Runtime: $RUNTIME"
echo ""

# Check prerequisites
command -v sam >/dev/null 2>&1 || { echo "❌ SAM CLI is required. Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI is required. Install: https://aws.amazon.com/cli/"; exit 1; }

# Check OpenAI API key
if [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ OPENAI_API_KEY environment variable is required"
    exit 1
fi

# Build based on runtime
case "$RUNTIME" in
    typescript)
        echo "📦 Building TypeScript..."
        cd typescript
        npm install
        npm run build
        cd ..
        ;;
    python)
        echo "📦 Building Python..."
        cd python
        pip install -r requirements.txt -t . --quiet
        cd ..
        ;;
    rust)
        echo "📦 Building Rust..."
        command -v cargo-lambda >/dev/null 2>&1 || { echo "❌ cargo-lambda is required. Install: cargo install cargo-lambda"; exit 1; }
        cd rust
        cargo lambda build --release
        cd ..
        ;;
    *)
        echo "❌ Unknown runtime: $RUNTIME"
        echo "   Supported: typescript, python, rust"
        exit 1
        ;;
esac

echo ""
echo "🌩️  Deploying to AWS..."
sam deploy \
    --parameter-overrides \
        RuntimeLanguage="$RUNTIME" \
        OpenAIApiKey="$OPENAI_API_KEY" \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Get your API endpoint:"
echo "   aws cloudformation describe-stacks --stack-name eliza-worker --query 'Stacks[0].Outputs[?OutputKey==\`ChatEndpoint\`].OutputValue' --output text"










