#!/bin/bash
# Test AWS Lambda TypeScript handler
# Run from: examples/aws/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(dirname "$SCRIPT_DIR")"

echo "========================================"
echo "🧪 Testing AWS Lambda handler (TypeScript)"
echo "========================================"
echo ""

cd "$AWS_DIR"
bun run test

echo ""
echo "========================================"
echo "✅ Tests passed"
echo "========================================"
