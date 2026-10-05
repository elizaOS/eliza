#!/usr/bin/env bash
set -euo pipefail

REAL_HDIUTIL="${ELECTROBUN_REAL_HDIUTIL:-/usr/bin/hdiutil}"

if [[ "${1:-}" == "create" ]]; then
  attempts=5
  delay=5
  last_status=0
  last_output=""

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if output="$("$REAL_HDIUTIL" "$@" 2>&1)"; then
      [[ -n "$output" ]] && printf '%s\n' "$output"
      exit 0
    fi

    last_status=$?
    last_output="$output"
    printf '%s\n' "$output" >&2

    if [[ "$output" != *"Resource busy"* || "$attempt" -eq "$attempts" ]]; then
      break
    fi

    echo "hdiutil create attempt $attempt/$attempts failed with Resource busy; retrying in ${delay}s..." >&2
    sleep "$delay"
  done

  exit "$last_status"
fi

exec "$REAL_HDIUTIL" "$@"
