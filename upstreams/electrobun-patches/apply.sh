#!/usr/bin/env bash
# Apply elizaOS patches on top of the pinned Electrobun submodule.
# Idempotent: re-running after a successful apply is a no-op (git apply --check
# will reject already-applied patches; we detect that and skip).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBMODULE="$(cd "$HERE/../electrobun" && pwd)"

cd "$SUBMODULE"

for patch in "$HERE"/*.patch; do
  if git apply --check "$patch" >/dev/null 2>&1; then
    echo "[electrobun-patches] applying $(basename "$patch")"
    git apply "$patch"
  elif git apply --reverse --check "$patch" >/dev/null 2>&1; then
    echo "[electrobun-patches] $(basename "$patch") already applied — skip"
  else
    echo "[electrobun-patches] $(basename "$patch") cannot be applied cleanly" >&2
    exit 1
  fi
done
