#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 OUTPUT.node" >&2
  exit 64
fi

output=$1
case "$output" in
  /*) ;;
  *)
    echo "native addon output must be an absolute path" >&2
    exit 64
    ;;
esac

mkdir -p -- "$(dirname -- "$output")"
${CC:-cc} -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared \
  "$(dirname -- "$0")/linux-peer-credentials.c" \
  -o "$output"
