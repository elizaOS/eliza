#!/usr/bin/env bash
set -e

# Test the Rust WASM package using Chrome headless
# Requires: wasm-pack (cargo install wasm-pack)
#
# Usage:
#   ./wasm-test.sh          # Run with Chrome (default)
#   ./wasm-test.sh firefox  # Run with Firefox
#   ./wasm-test.sh node     # Run with Node.js

cd "$(dirname "$0")"

BROWSER="${1:-chrome}"

echo "Running WASM tests with $BROWSER..."

# RUSTFLAGS explanation:
# --cfg getrandom_backend="wasm_js" - Use JS random for getrandom in WASM
# -Awarnings - Allow warnings (optional, remove for strict mode)

case "$BROWSER" in
    chrome)
        RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
            wasm-pack test --headless --chrome
        ;;
    firefox)
        RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
            wasm-pack test --headless --firefox
        ;;
    node)
        RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
            wasm-pack test --node
        ;;
    *)
        echo "Unknown browser: $BROWSER"
        echo "Usage: $0 [chrome|firefox|node]"
        exit 1
        ;;
esac

echo "WASM tests passed!"

