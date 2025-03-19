#!/bin/bash

# Script to update BNB Chain blog posts for Eliza RAG
# This script fetches the latest blog posts from the BNB Chain website
# and updates the characters/knowledge/bnb-blog directory.

set -e

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Log timestamp
timestamp() {
  date +"[%Y-%m-%d %H:%M:%S]"
}

echo "$(timestamp) Fetching BNB Chain blog posts..."

# Run the fetch script
node scripts/fetch-bnb-blog.js

if [ $? -eq 0 ]; then
  echo "$(timestamp) BNB Chain blog posts fetched successfully."
  echo "$(timestamp) Done. Eliza will use the updated BNB Chain blog posts on next startup."

  echo ""
  echo "==============================================="
  echo "BNB Chain blog posts have been updated successfully."
  echo "To start Eliza with these blog posts, run:"
  echo ""
  echo "  pnpm start --characters=\"$(pwd)/characters/rag-eliza.json\""
  echo ""
  echo "You can add this script to your crontab to run weekly:"
  echo ""
  echo "  0 0 * * 0 $(pwd)/scripts/update-bnb-blog.sh > /dev/null 2>&1"
  echo ""
  echo "==============================================="
else
  echo "$(timestamp) Error fetching BNB Chain blog posts."
  exit 1
fi
