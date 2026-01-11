#!/bin/bash
# Deploy elizaOS Vercel Edge Functions
#
# Usage:
#   ./scripts/deploy.sh           # Preview deployment
#   ./scripts/deploy.sh --prod    # Production deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "🚀 Deploying elizaOS Vercel Edge Functions"
echo ""

# Check for Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI not found. Install with: npm i -g vercel"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
if command -v bun &> /dev/null; then
    bun install
else
    npm install
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
if command -v bun &> /dev/null; then
    bun run build:ts
else
    npx tsc
fi

# Check for Rust/WASM build (optional)
if [ -d "rust" ] && command -v wasm-pack &> /dev/null; then
    echo "🦀 Building Rust WASM..."
    cd rust
    wasm-pack build --target web --out-dir ../api/rust/pkg
    cd ..
fi

# Deploy
if [ "$1" == "--prod" ]; then
    echo "🌐 Deploying to production..."
    vercel deploy --prod
else
    echo "🔍 Creating preview deployment..."
    vercel deploy
fi

echo ""
echo "✅ Deployment complete!"










