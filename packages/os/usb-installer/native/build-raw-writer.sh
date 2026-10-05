#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output="${1:?Pass an absolute output path}"
[[ "$output" = /* ]] || { echo 'Output path must be absolute' >&2; exit 2; }
[[ "$(uname -s)" = Linux ]] || { echo 'Build the Linux writer on Linux' >&2; exit 2; }
mkdir -p -- "$(dirname -- "$output")"
"${CC:-cc}" -std=c11 -O2 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 \
  "$source_dir/linux-raw-writer.c" \
  "$source_dir/../../linux/installer/native/gpt-snapshot.c" -lcrypto -o "$output"
