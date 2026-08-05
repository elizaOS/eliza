#!/usr/bin/env bash
# Pull or push Clawd roster models into a running Fly Ollama machine.
#
# Usage:
#   ./pull-models.sh                  # pull public-friendly tags via ollama pull
#   ./pull-models.sh --from-local     # create models on the remote from local ollama
#
# Requires: fly CLI authenticated, app clawd-ollama deployed.

set -euo pipefail

APP="${FLY_APP:-clawd-ollama}"
MODE="${1:-}"

# Small + medium first (practical on CPU). Large needs GPU.
PUBLICISH_TAGS=(
  "nomic-embed-text"
)

# Local-only custom tags (push via ollama + fly ssh when using --from-local)
LOCAL_TAGS=(
  "8bit/solana-clawd-core-ai:latest"
  "8bit/solana-trading-factory:8b-lora-20260620"
  "8bit/hauhau-qwen36-onchain:latest"
  "ordlibrary/clawd-trading-wallet:latest"
  "ordlibrary/core-ai-clawd-1.5b:latest"
  "ordlibrary/core-ai-clawd-1.5b:finetuned"
)

remote_ollama() {
  fly ssh console -a "$APP" -C "ollama $*"
}

if [[ "$MODE" == "--from-local" ]]; then
  echo "Exporting local models and importing on Fly is multi-GB."
  echo "Preferred workflow:"
  echo "  1) On a machine with the blobs, run: ollama create <tag> ..."
  echo "  2) fly ssh console -a $APP"
  echo "  3) Inside the VM: ollama pull/create the tags you need"
  echo
  echo "For private registries, mirror GGUF into the volume under /root/.ollama"
  echo "or use \`ollama create\` with a Modelfile pointing at a public HF GGUF."
  exit 0
fi

echo "Pulling lightweight tags on $APP..."
for tag in "${PUBLICISH_TAGS[@]}"; do
  echo "→ $tag"
  fly ssh console -a "$APP" -C "ollama pull $tag" || true
done

echo
echo "Custom 8bit/ordlibrary tags are private local builds."
echo "SSH in and create/import them, or use a HF GGUF Modelfile:"
echo "  fly ssh console -a $APP"
echo "  ollama list"
echo
echo "Target agent env once models are present:"
echo "  OLLAMA_API_ENDPOINT=https://${APP}.fly.dev/api"
echo "  OLLAMA_BASE_URL=https://${APP}.fly.dev"
echo "  OLLAMA_SMALL_MODEL=8bit/solana-clawd-core-ai:latest"
echo "  OLLAMA_MEDIUM_MODEL=8bit/solana-trading-factory:8b-lora-20260620"
echo "  OLLAMA_LARGE_MODEL=8bit/hauhau-qwen36-onchain:latest"
