#!/usr/bin/env bash
# Generate offline node sources for the elizaOS App Flatpak.
#
# Flathub's build infrastructure forbids network access during the build
# phase. This script invokes `flatpak-node-generator` to produce a
# `node-sources.json` manifest that lists every npm tarball + hash the
# `elizaos` CLI install needs, so the Flathub build can populate
# /app via vendored sources instead of `npm install -g elizaos`.
#
# Prerequisites (Linux only — flatpak-builder is Linux-only):
#   - python3
#   - pipx (recommended) OR pip
#   - network access (this script is the one place we DO need it)
#
# Usage:
#   ./generate-sources.sh            # writes node-sources.json next to the manifest
#   ./generate-sources.sh /tmp/out   # writes /tmp/out/node-sources.json
#
# After running, commit node-sources.json alongside the manifest so the
# Flathub build can reproduce the install offline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RM_PATH_RECURSIVE="${REPO_ROOT}/packages/scripts/rm-path-recursive.mjs"
OUT_DIR="${1:-$SCRIPT_DIR}"
OUT_FILE="$OUT_DIR/node-sources.json"

if ! command -v flatpak-node-generator >/dev/null 2>&1; then
  echo "flatpak-node-generator not found on PATH." >&2
  echo "Install it with one of:" >&2
  echo "  pipx install flatpak-node-generator" >&2
  echo "  pip install --user flatpak-node-generator" >&2
  echo "Source: https://github.com/flatpak/flatpak-builder-tools/tree/master/node" >&2
  exit 1
fi

# flatpak-node-generator needs a package-lock.json or yarn.lock to derive
# the exact dependency closure. We don't ship a lockfile inside the flatpak
# packaging dir, so synthesize one from a fresh install of the latest
# published `elizaos` CLI in a temp dir.
WORK_DIR="$(mktemp -d)"
cleanup() {
  node "${RM_PATH_RECURSIVE}" "${WORK_DIR}"
}
trap cleanup EXIT

echo "[generate-sources] Resolving elizaos dependency closure in $WORK_DIR" >&2
(
  cd "$WORK_DIR"
  # Seed a minimal package.json with a `name` field. Without this,
  # `npm install --package-lock-only` writes a `package.json` that
  # only contains a `dependencies` block, and flatpak-node-generator
  # 0.1.1 crashes with `KeyError: 'name'` when it parses the root
  # package entry of the resulting lockfile.
  cat > package.json <<'PKG'
{
  "name": "elizaos-flatpak-sources-shim",
  "version": "0.0.0",
  "private": true
}
PKG
  # `npm install --package-lock-only` writes the lockfile without
  # actually fetching/extracting tarballs into node_modules. We just
  # need the resolved graph for flatpak-node-generator.
  npm install --package-lock-only --ignore-scripts elizaos@latest
)

echo "[generate-sources] Generating $OUT_FILE" >&2
flatpak-node-generator npm \
  --recursive \
  -o "$OUT_FILE" \
  "$WORK_DIR/package-lock.json"

echo "[generate-sources] Wrote $OUT_FILE" >&2
echo "[generate-sources] Add the following to ai.elizaos.App.yml under the elizaos-app module sources:" >&2
echo "      - type: file" >&2
echo "        path: node-sources.json" >&2
