#!/bin/bash
# Run WASM tests with wasm-pack

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/ensure-wasm-tools.sh"

TARGET="${1:-chrome}"
FEATURES="--no-default-features --features wasm"

case "${TARGET}" in
  node)
    wasm-pack test --node ${FEATURES}
    ;;
  firefox)
    wasm-pack test --firefox --headless ${FEATURES}
    ;;
  chrome)
    wasm-pack test --chrome --headless ${FEATURES}
    ;;
  *)
    echo "Usage: ./wasm-test.sh [chrome|firefox|node]"
    exit 1
    ;;
esac
