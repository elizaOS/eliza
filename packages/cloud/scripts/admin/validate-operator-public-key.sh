#!/usr/bin/env bash
set -euo pipefail

public_key_path="${1:-}"
[ -n "$public_key_path" ] && [ -f "$public_key_path" ] || exit 1
line_count="$(awk 'END { print NR + 0 }' "$public_key_path")"
[ "$line_count" -eq 1 ] || exit 1
awk '$1 == "ssh-ed25519" && NF >= 2 && $0 !~ /\r/ { valid = 1 } END { exit !valid }' "$public_key_path" || exit 1
# OpenSSH public-key comments are allowed after field two. Validate only the
# literal key type and blob so host prefixes and authorized-key options cannot
# be reinterpreted as a deployable operator key.
description="$(awk '{ print $1, $2 }' "$public_key_path" | ssh-keygen -E sha256 -lf - 2>/dev/null)" || exit 1
bits="$(awk '{print $1}' <<<"$description")"
key_type="$(awk '{print $NF}' <<<"$description")"
[ "$bits" = 256 ] && [ "$key_type" = '(ED25519)' ]
