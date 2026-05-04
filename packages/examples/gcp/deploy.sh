#!/bin/bash
#
# Deploy elizaOS Cloud Run worker to GCP
#
# Usage:
#   ./deploy.sh [runtime] [options]
#
# Runtimes:
#   typescript (default)
#   python
#   rust
#
# Options:
#   --region REGION       GCP region (default: us-central1)
#   --project PROJECT_ID  GCP project ID
#   --name SERVICE_NAME   Service name (default: eliza-worker)
#   --min-instances N     Minimum instances (default: 0)
#   --max-instances N     Maximum instances (default: 100)
#   --memory MEMORY       Memory allocation (default: 512Mi)
#   --cpu CPU             CPU allocation (default: 1)
#   --timeout TIMEOUT     Request timeout (default: 60s)
#   --openai-key KEY      OpenAI API key (or use OPENAI_API_KEY env var)
#   --use-secret          Use Secret Manager for API key
#
# Examples:
#   ./deploy.sh typescript
#   ./deploy.sh python --region europe-west1
#   ./deploy.sh rust --min-instances 1 --memory 256Mi

set -e

# Default values
RUNTIME="typescript"
REGION="${GCP_REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
SERVICE_NAME="eliza-worker"
MIN_INSTANCES="0"
MAX_INSTANCES="100"
MEMORY="512Mi"
CPU="1"
TIMEOUT="60s"
OPENAI_KEY="${OPENAI_API_KEY:-}"
USE_SECRET=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        typescript|python|rust)
            RUNTIME="$1"
            shift
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        --project)
            PROJECT_ID="$2"
            shift 2
            ;;
        --name)
            SERVICE_NAME="$2"
            shift 2
            ;;
        --min-instances)
            MIN_INSTANCES="$2"
            shift 2
            ;;
        --max-instances)
            MAX_INSTANCES="$2"
            shift 2
            ;;
        --memory)
            MEMORY="$2"
            shift 2
            ;;
        --cpu)
            CPU="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --openai-key)
            OPENAI_KEY="$2"
            shift 2
            ;;
        --use-secret)
            USE_SECRET=true
            shift
            ;;
        --help|-h)
            head -40 "$0" | tail -n +2 | sed 's/^#//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate
if [ -z "$PROJECT_ID" ]; then
    echo "❌ Project ID not set. Use --project or set PROJECT_ID environment variable."
    exit 1
fi

if [ -z "$OPENAI_KEY" ] && [ "$USE_SECRET" = false ]; then
    echo "❌ OpenAI API key not set. Use --openai-key, OPENAI_API_KEY env var, or --use-secret."
    exit 1
fi

echo "🚀 Deploying elizaOS Cloud Run worker"
echo ""
echo "  Runtime:       $RUNTIME"
echo "  Region:        $REGION"
echo "  Project:       $PROJECT_ID"
echo "  Service:       $SERVICE_NAME-$RUNTIME"
echo "  Memory:        $MEMORY"
echo "  CPU:           $CPU"
echo "  Min instances: $MIN_INSTANCES"
echo "  Max instances: $MAX_INSTANCES"
echo "  Timeout:       $TIMEOUT"
echo ""

# Change to runtime directory
cd "$(dirname "$0")/$RUNTIME"

# Build environment variables argument
ENV_VARS="LOG_LEVEL=INFO"

if [ "$USE_SECRET" = true ]; then
    echo "📦 Using Secret Manager for OPENAI_API_KEY..."
    SECRETS_ARG="--set-secrets=OPENAI_API_KEY=openai-api-key:latest"
else
    ENV_VARS="$ENV_VARS,OPENAI_API_KEY=$OPENAI_KEY"
    SECRETS_ARG=""
fi

# Deploy using gcloud run deploy --source (builds automatically)
echo "📦 Building and deploying..."
gcloud run deploy "$SERVICE_NAME-$RUNTIME" \
    --source . \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --allow-unauthenticated \
    --memory "$MEMORY" \
    --cpu "$CPU" \
    --timeout "$TIMEOUT" \
    --min-instances "$MIN_INSTANCES" \
    --max-instances "$MAX_INSTANCES" \
    --set-env-vars "$ENV_VARS" \
    $SECRETS_ARG

# Get service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME-$RUNTIME" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --format 'value(status.url)')

echo ""
echo "✅ Deployment complete!"
echo ""
echo "🌐 Service URL: $SERVICE_URL"
echo ""
echo "📝 Test with:"
echo "   # Health check"
echo "   curl $SERVICE_URL/health"
echo ""
echo "   # Chat"
echo "   curl -X POST $SERVICE_URL/chat \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"message\": \"Hello, Eliza!\"}'"
echo ""
echo "   # Interactive client"
echo "   cd $(dirname "$0")"
echo "   bun run test-client.ts --url $SERVICE_URL"
echo ""










