#!/bin/bash

# This script provides a lightweight test during Docker build
# without requiring full npm operations

echo "🔍 Running lightweight build verification..."

# Check for critical files
if [ ! -d "packages" ]; then
  echo "❌ Error: 'packages' directory not found"
  exit 1
fi

# Verify TypeScript configuration
if [ ! -f "tsconfig.json" ]; then
  echo "❌ Error: tsconfig.json not found"
  exit 1
fi

# Ensure node_modules directory exists
mkdir -p node_modules/@types/node

# Verify packages structure
for pkg in core client; do
  if [ ! -d "packages/$pkg" ]; then
    echo "❌ Error: packages/$pkg directory not found"
    exit 1
  fi
  
  # Ensure package subdirectories exist
  mkdir -p "packages/$pkg/src/lib"
  mkdir -p "packages/$pkg/node_modules/@types"
done

# Test for Node.js types
echo "Checking TypeScript configurations..."
for tsconfig in $(find packages -name "tsconfig*.json"); do
  # Check if types includes node
  if ! grep -q '"types".*"node"' "$tsconfig"; then
    echo "⚠️ Warning: $tsconfig might be missing Node.js type definitions"
  fi
done

# Create info.json in client package for version testing
echo "Testing version script functionality..."
VERSION=$(grep -o '"version": *"[^"]*"' "lerna.json" | awk -F: '{ gsub(/[ ",]/, "", $2); print $2 }')
if [ -n "$VERSION" ]; then
  mkdir -p packages/client/src/lib
  echo "{\"version\": \"$VERSION\"}" > packages/client/src/lib/info.json
  echo "✅ Successfully created version info: $VERSION"
else
  echo "❌ Error: Could not extract version from lerna.json"
  exit 1
fi

echo "✅ Build verification completed successfully"
exit 0 