#!/usr/bin/env bash
set -euo pipefail

echo "Building CLI package..."
bun run build

echo "Running minimal test with elizaos create -y -t project..."
cd /tmp
rm -rf test-proj
export ELIZAOS_DEBUG=true
elizaos create test-proj -y -t project
CODE=$?
echo "Exit code: $CODE"

if [ -d "test-proj" ]; then
  echo "Project directory created: test-proj"
  if [ -f "test-proj/package.json" ]; then
    echo "package.json file found"
  else
    echo "package.json file NOT found"
  fi
else
  echo "Project directory NOT created: test-proj"
fi

echo "Done" 