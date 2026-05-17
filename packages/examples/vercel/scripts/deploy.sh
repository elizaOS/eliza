#!/bin/bash
# Deploy elizaOS Vercel Edge Functions (TypeScript)
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

if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI not found. Install with: npm i -g vercel"
    exit 1
fi

echo "📦 Installing dependencies..."
if command -v bun &> /dev/null; then
    bun install
else
    npm install
fi

echo "🔨 Building TypeScript..."
if command -v bun &> /dev/null; then
    bun run build
else
    npx tsc --noEmit
fi

if [ "$1" == "--prod" ]; then
    echo "🌐 Deploying to production..."
    vercel deploy --prod
else
    echo "🔍 Creating preview deployment..."
    vercel deploy
fi

echo ""
echo "✅ Deployment complete!"
