#!/usr/bin/env bash
set -euo pipefail

public_key_path="${1:-}"
[ -n "$public_key_path" ] && [ -f "$public_key_path" ] || exit 1
line_count="$(awk 'NF { count += 1 } END { print count + 0 }' "$public_key_path")"
[ "$line_count" -eq 1 ] || exit 1
description="$(ssh-keygen -E sha256 -lf "$public_key_path" 2>/dev/null)" || exit 1
bits="$(awk '{print $1}' <<<"$description")"
key_type="$(awk '{print $NF}' <<<"$description")"
[ "$bits" = 256 ] && [ "$key_type" = '(ED25519)' ]
