#!/bin/bash
# Script to unpublish all -root plugin packages from npm
# These packages should not be published - only the typescript/ subdirectory packages should be published

set -e

VERSION="2.0.0-alpha.1"

PACKAGES=(
  "@elizaos/plugin-anthropic-root"
  "@elizaos/plugin-auto-trader-root"
  "@elizaos/plugin-bluesky-root"
  "@elizaos/plugin-browser-root"
  "@elizaos/plugin-code-root"
  "@elizaos/plugin-computeruse-root"
  "@elizaos/plugin-discord-root"
  "@elizaos/plugin-elevenlabs-root"
  "@elizaos/plugin-eliza-classic-root"
  "@elizaos/plugin-elizacloud-root"
  "@elizaos/plugin-evm-root"
  "@elizaos/plugin-experience-root"
  "@elizaos/plugin-farcaster-root"
  "@elizaos/plugin-github-root"
  "@elizaos/plugin-goals-root"
  "@elizaos/plugin-google-genai-root"
  "@elizaos/plugin-groq-root"
  "@elizaos/plugin-inmemorydb-root"
  "@elizaos/plugin-instagram-root"
  "@elizaos/plugin-knowledge-root"
  "@elizaos/plugin-linear-root"
  "@elizaos/plugin-local-ai-root"
  "@elizaos/plugin-localdb-root"
  "@elizaos/plugin-mcp-root"
  "@elizaos/plugin-minecraft-root"
  "@elizaos/plugin-n8n-root"
  "@elizaos/plugin-ollama-root"
  "@elizaos/plugin-openai-root"
  "@elizaos/plugin-openrouter-root"
  "@elizaos/plugin-pdf-root"
  "@elizaos/plugin-polymarket-root"
  "@elizaos/plugin-roblox-root"
  "@elizaos/plugin-rss-root"
  "@elizaos/plugin-s3-storage-root"
  "@elizaos/plugin-shell-root"
  "@elizaos/plugin-simple-voice-root"
  "@elizaos/plugin-solana-root"
  "@elizaos/plugin-sql-root"
  "@elizaos/plugin-tee-root"
  "@elizaos/plugin-telegram-root"
  "@elizaos/plugin-todo-root"
  "@elizaos/plugin-trajectory-logger-root"
  "@elizaos/plugin-vercel-ai-gateway-root"
  "@elizaos/plugin-vision-root"
  "@elizaos/plugin-xai-root"
)

echo "This script will unpublish ${#PACKAGES[@]} root packages from npm"
echo "Version: $VERSION"
echo ""
echo "Packages to unpublish:"
for pkg in "${PACKAGES[@]}"; do
  echo "  - $pkg@$VERSION"
done
echo ""
read -p "Are you sure you want to continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "Starting unpublish process..."
echo ""

FAILED=()
SUCCESS=()

for pkg in "${PACKAGES[@]}"; do
  echo "Unpublishing $pkg@$VERSION..."
  if npm unpublish "$pkg@$VERSION" --force 2>/dev/null; then
    echo "  ✓ Successfully unpublished $pkg@$VERSION"
    SUCCESS+=("$pkg")
  else
    echo "  ✗ Failed to unpublish $pkg@$VERSION (may not exist or already unpublished)"
    FAILED+=("$pkg")
  fi
done

echo ""
echo "=========================================="
echo "Summary:"
echo "  Successfully unpublished: ${#SUCCESS[@]}"
echo "  Failed/Already unpublished: ${#FAILED[@]}"
echo "=========================================="

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "Failed packages:"
  for pkg in "${FAILED[@]}"; do
    echo "  - $pkg"
  done
fi
