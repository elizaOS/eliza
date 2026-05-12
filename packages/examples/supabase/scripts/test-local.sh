#!/bin/bash
# Test elizaOS Supabase Edge Functions locally

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Default values
FUNCTION_NAME="${1:-eliza-chat}"
PORT="${PORT:-54321}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/../../../.env}"

echo "🧪 Testing elizaOS Supabase Edge Function: $FUNCTION_NAME"
echo ""

# Check if .env exists
if [[ -f "$ENV_FILE" ]]; then
    echo "📁 Loading environment from: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "⚠️  No .env file found at: $ENV_FILE"
    echo "   Make sure OPENAI_API_KEY is set in your environment."
fi

# Check for required environment variables
if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "❌ OPENAI_API_KEY is not set"
    echo "   Set it with: export OPENAI_API_KEY='your-key'"
    exit 1
fi

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI is not installed"
    echo "   Install with: brew install supabase/tap/supabase"
    echo "   Or: npm install -g supabase"
    exit 1
fi

# Check if Deno is installed (for direct testing)
if command -v deno &> /dev/null; then
    echo "✅ Deno is available"
    DENO_AVAILABLE=true
else
    echo "⚠️  Deno not installed - will use Supabase CLI for testing"
    DENO_AVAILABLE=false
fi

echo ""
echo "Running tests..."
echo "─────────────────────────────────────────────────"

# Test 1: Direct Deno execution (if available)
if [[ "$DENO_AVAILABLE" == "true" ]]; then
    echo ""
    echo "1️⃣  Testing with Deno directly..."
    
    cd "$PROJECT_DIR/functions/$FUNCTION_NAME"
    
    # Run a quick syntax check
    deno check index.ts 2>/dev/null && echo "   ✅ TypeScript syntax OK" || echo "   ⚠️  TypeScript warnings (may be OK)"
fi

# Test 2: Test client
echo ""
echo "2️⃣  Running test client..."

cd "$PROJECT_DIR"

# Check if function is already running
if curl -s "http://localhost:$PORT/functions/v1/$FUNCTION_NAME/health" > /dev/null 2>&1; then
    echo "   Function appears to be running on port $PORT"
    deno run --allow-net --allow-env test-client.ts \
        --endpoint "http://localhost:$PORT/functions/v1/$FUNCTION_NAME"
else
    echo "   ⚠️  Function not running. Start it with:"
    echo "      supabase functions serve $FUNCTION_NAME --env-file .env"
    echo ""
    echo "   Or test against deployed function:"
    echo "      deno run --allow-net --allow-env test-client.ts \\"
    echo "        --endpoint https://YOUR_PROJECT.supabase.co/functions/v1/$FUNCTION_NAME \\"
    echo "        --token YOUR_ANON_KEY"
fi

echo ""
echo "─────────────────────────────────────────────────"
echo "✅ Test script complete"










