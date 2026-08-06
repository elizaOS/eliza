#!/usr/bin/env sh
set -eu

PACKAGE_NAME="${CLAWD_CODE_PACKAGE:-@solana-clawd/clawd-code}"
# Standalone package repo (package root is the repo root, not a monorepo subdir).
REPO_URL="${CLAWD_CODE_REPO:-https://github.com/Solizardking/clawd-code.git}"
REF="${CLAWD_CODE_REF:-main}"
INSTALL_DIR="${CLAWD_CODE_INSTALL_DIR:-$HOME/.clawd-code/src}"
CONFIG_DIR="${CLAWD_CODE_CONFIG_DIR:-$HOME/.clawd-code}"
SOURCE_DIR="${CLAWD_CODE_SOURCE_DIR:-}"
SMOKE_TEST="${CLAWD_CODE_SMOKE_TEST:-false}"

is_true() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_true "$SMOKE_TEST"; then
  LINK_BINARY="${CLAWD_CODE_LINK_BINARY:-false}"
else
  LINK_BINARY="${CLAWD_CODE_LINK_BINARY:-true}"
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "clawd-code installer: missing required command: $1" >&2
    exit 1
  fi
}

script_dir() {
  case "$0" in
    /*) dirname "$0" ;;
    */*) cd "$(dirname "$0")" && pwd ;;
    *) echo "" ;;
  esac
}

find_package_dir() {
  root="$1"
  for candidate in "$root" "$root/clawd-code"; do
    if [ -f "$candidate/package.json" ] && [ -f "$candidate/src/cli.ts" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

install_from_source() {
  package_dir="$1"
  echo "Installing from source: $package_dir"
  cd "$package_dir"
  npm install
  npm run build
  if [ -f "$package_dir/dist/cli.js" ]; then
    chmod +x "$package_dir/dist/cli.js"
  fi
  if is_true "$LINK_BINARY"; then
    npm link
  else
    echo "Skipping npm link (CLAWD_CODE_LINK_BINARY=false)."
  fi
}

need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "clawd-code requires Node.js >= 18. Current: $(node -v)" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"

PACKAGE_DIR=""
SCRIPT_DIR="$(script_dir)"
if [ -z "$SOURCE_DIR" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
fi

if [ -n "$SOURCE_DIR" ]; then
  PACKAGE_DIR="$(find_package_dir "$SOURCE_DIR")" || {
    echo "clawd-code installer: no package.json + src/cli.ts under CLAWD_CODE_SOURCE_DIR=$SOURCE_DIR" >&2
    exit 1
  }
  install_from_source "$PACKAGE_DIR"
elif npm view "$PACKAGE_NAME" version >/dev/null 2>&1; then
  echo "Installing $PACKAGE_NAME globally from npm..."
  npm install -g "$PACKAGE_NAME"
else
  need git
  echo "npm package not found; installing from $REPO_URL#$REF..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  if git ls-tree -d --name-only HEAD | grep -qx 'clawd-code'; then
    git sparse-checkout set clawd-code
  else
    git sparse-checkout disable
  fi
  PACKAGE_DIR="$(find_package_dir "$INSTALL_DIR")" || {
    echo "clawd-code installer: cloned repo does not contain clawd-code package root" >&2
    exit 1
  }
  install_from_source "$PACKAGE_DIR"
fi

if [ ! -f "$CONFIG_DIR/.env" ]; then
  if [ -n "$PACKAGE_DIR" ] && [ -f "$PACKAGE_DIR/.env.example" ]; then
    cp "$PACKAGE_DIR/.env.example" "$CONFIG_DIR/.env"
  else
    cat > "$CONFIG_DIR/.env" <<'ENV'
CLAWD_MODE=code
CLAWD_PROVIDER=zai
CLAWD_MODEL=glm-5.2
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_CLUSTER=mainnet-beta
SOLANA_COMMITMENT=confirmed
SOLANA_HARNESS_READONLY=true
LIVE_TRADING=false
OPERATOR_CONFIRMED=false
PERPS_SIM_ONLY=true
PERPS_MAX_NOTIONAL_USD=250
PERPS_MAX_LEVERAGE=3
PERPS_ALLOWED_SYMBOLS=SOL,ETH,BTC
IMPERIAL_ENABLED=false
IMPERIAL_LIVE=false
IMPERIAL_API_BASE_URL=https://api.imperial.space/api/v1
IMPERIAL_WS_URL=wss://api.imperial.space/ws
IMPERIAL_MARKET_WS_URL=wss://api.imperial.space/ws/market
IMPERIAL_WALLET=
IMPERIAL_JWT=
IMPERIAL_PROFILE_INDEX=0
IMPERIAL_DEFAULT_UNDERWRITER=2
IMPERIAL_PREFER_PHOENIX=true
IMPERIAL_ALLOWED_SYMBOLS=SOL,ETH,BTC
IMPERIAL_MAX_NOTIONAL_USD=250
IMPERIAL_MAX_LEVERAGE=3
ZAI_API_KEY=
ZAI_BASE_URL=https://api.z.ai/api/paas/v4
ZAI_AGENT_BASE_URL=https://api.z.ai/api/v1
ZAI_MODEL=glm-5.2
ZAI_CHART_MODEL=glm-5.2
ZAI_VISION_MODEL=glm-5v-turbo
ZAI_TRADE_VISION_MODEL=glm-5v-turbo
ZAI_CHART_VISION_MODEL=glm-5v-turbo
ZAI_IMAGE_MODEL=glm-image
ZAI_THINKING=enabled
ZAI_REASONING_EFFORT=max
XAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
OPENROUTER_API_KEY=
OPENROUTER_NEMO_MODEL1=nvidia/nemotron-3-ultra-550b-a55b:free
OPENROUTER_NEMO_MODEL2=nvidia/nemotron-3-ultra-550b-a55b
OPENROUTER_NEMO_MODEL3=nvidia/nemotron-3-super-120b-a12b:free
OPENROUTER_FABLE5=anthropic/claude-fable-5
OPENROUTER_FABLE_LATESY=~anthropic/claude-fable-latest
ENV
  fi
  chmod 600 "$CONFIG_DIR/.env"
fi

echo
echo "clawd-code installed."
echo "Configure keys in: $CONFIG_DIR/.env"
if is_true "$SMOKE_TEST"; then
  echo "Smoke mode completed without linking the binary globally."
fi
echo "Try:"
echo "  clawd-code code \"Build a Jupiter swap bot in TypeScript\""
echo "  clawd-code wallet create"
echo "  clawd-code trade funding"
echo "  clawd-code spinner list"
