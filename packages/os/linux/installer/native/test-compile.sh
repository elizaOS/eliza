#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo "native Linux peer compile gate requires Linux" >&2
  exit 1
fi
test_directory=$(mktemp -d)
trap 'rm -rf -- "$test_directory"' EXIT
addon="$test_directory/linux-peer-credentials.node"
"$(dirname -- "$0")/build.sh" "$addon"
node "$(dirname -- "$0")/native-peer-credentials.compile.mjs" "$addon"
