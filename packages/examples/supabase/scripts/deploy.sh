#!/bin/bash
# Deploy elizaOS Supabase Edge Functions

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
FUNCTION_NAME="${1:-all}"
BUILD_WASM="${BUILD_WASM:-false}"

echo "🚀 Deploying elizaOS Supabase Edge Functions"
echo ""

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI is not installed"
    echo "   Install with: brew install supabase/tap/supabase"
    echo "   Or: npm install -g supabase"
    exit 1
fi

# Check if logged in
if ! supabase projects list &> /dev/null; then
    echo "❌ Not logged in to Supabase"
    echo "   Run: supabase login"
    exit 1
fi

# Build WASM if requested
if [[ "$BUILD_WASM" == "true" ]] || [[ "$FUNCTION_NAME" == "eliza-chat-wasm" ]] || [[ "$FUNCTION_NAME" == "all" ]]; then
    if [[ -d "$PROJECT_DIR/rust" ]]; then
        echo "🔧 Building WASM module..."
        "$SCRIPT_DIR/build-wasm.sh"
        echo ""
    fi
fi

# Deploy functions
deploy_function() {
    local name=$1
    echo "📦 Deploying function: $name"
    
    if [[ -d "$PROJECT_DIR/functions/$name" ]]; then
        supabase functions deploy "$name" --project-ref "${SUPABASE_PROJECT_REF:-}"
        echo "   ✅ Deployed: $name"
    else
        echo "   ❌ Function not found: $name"
        return 1
    fi
}

if [[ "$FUNCTION_NAME" == "all" ]]; then
    echo "Deploying all functions..."
    echo ""
    
    for func_dir in "$PROJECT_DIR/functions"/*/; do
        func_name=$(basename "$func_dir")
        deploy_function "$func_name" || true
        echo ""
    done
else
    deploy_function "$FUNCTION_NAME"
fi

echo ""
echo "─────────────────────────────────────────────────"
echo ""
echo "✅ Deployment complete!"
echo ""
echo "Don't forget to set your secrets:"
echo "  supabase secrets set OPENAI_API_KEY=your-key"
echo ""
echo "Test your deployment:"
echo "  curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/eliza-chat \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -H 'Authorization: Bearer YOUR_ANON_KEY' \\"
echo "    -d '{\"message\": \"Hello!\"}'"










