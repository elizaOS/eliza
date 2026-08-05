#!/usr/bin/env sh
set -eu

PACKAGE_NAME="${CLAWD_CODE_PACKAGE:-@solana-clawd/clawd-code}"
REPO_URL="${CLAWD_CODE_REPO:-https://github.com/Solizardking/solana-clawd.git}"
REF="${CLAWD_CODE_REF:-main}"
INSTALL_DIR="${CLAWD_CODE_INSTALL_DIR:-$HOME/.clawd-code/src}"
CONFIG_DIR="$HOME/.clawd-code"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "clawd-code installer: missing required command: $1" >&2
    exit 1
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

if npm view "$PACKAGE_NAME" version >/dev/null 2>&1; then
  echo "Installing $PACKAGE_NAME globally from npm..."
  npm install -g "$PACKAGE_NAME"
else
  need git
  echo "npm package not found; installing from $REPO_URL#$REF..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git sparse-checkout set clawd-code
  cd "$INSTALL_DIR/clawd-code"
  npm install
  npm run build
  npm link
fi

if [ ! -f "$CONFIG_DIR/.env" ]; then
  if [ -f "$INSTALL_DIR/clawd-code/.env.example" ]; then
    cp "$INSTALL_DIR/clawd-code/.env.example" "$CONFIG_DIR/.env"
  else
    cat > "$CONFIG_DIR/.env" <<'ENV'
CLAWD_MODE=code
CLAWD_PROVIDER=xai
CLAWD_MODEL=grok-4.20-multi-agent
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
LIVE_TRADING=false
OPERATOR_CONFIRMED=false
PERPS_SIM_ONLY=true
PERPS_MAX_NOTIONAL_USD=250
PERPS_MAX_LEVERAGE=3
PERPS_ALLOWED_SYMBOLS=SOL,ETH,BTC
XAI_API_KEY=
DEEPSEEK_API_KEY=
OPENROUTER_API_KEY=
ENV
  fi
  chmod 600 "$CONFIG_DIR/.env"
fi

echo
echo "clawd-code installed."
echo "Configure keys in: $CONFIG_DIR/.env"
echo "Try:"
echo "  clawd-code code \"Build a Jupiter swap bot in TypeScript\""
echo "  clawd-code wallet create"
echo "  clawd-code trade funding"
