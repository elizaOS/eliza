#!/bin/bash

# Navigate to the script's directory
cd "$(dirname "$0")"/..
echo "Cleanup started."
# Find and remove node_modules directories, dist directories.
find . -type d -name "node_modules" -exec rm -rf {} +
find . -type d -name "dist" -exec rm -rf {} +
find . -type d -name ".turbo" -exec rm -rf {} +

# Remove core cache
rm -rf ./packages/core/cache

# Remove pnpm lockfile
rm -f ./pnpm-lock.yaml

echo "Cleanup completed."
exit 0
