#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <browser> [browser...]" >&2
  exit 2
fi

if [ "${RUNNER_OS:-}" = "Linux" ] || [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    exec bunx playwright install --with-deps "$@"
  fi
  echo "::notice::passwordless sudo unavailable; installing Playwright browsers without OS deps"
fi

exec bunx playwright install "$@"
