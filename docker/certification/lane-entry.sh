#!/usr/bin/env bash
# Entrypoint for the cpu-profile lane containers: sync the read-only /repo
# mount into this lane's writable /work scratch (tests write node_modules,
# dist, .turbo, tmp files), install through the shared /cache bun cache, then
# exec the lane command the generator baked into LANE_COMMAND. The scratch
# volume persists between runs, so the rsync is incremental after the first.
set -euo pipefail

: "${LANE_NAME:?LANE_NAME is required}"
: "${LANE_COMMAND:?LANE_COMMAND is required}"

mkdir -p /work/repo
if command -v rsync >/dev/null 2>&1; then
  # node_modules is reproduced by bun install below; syncing it from the host
  # would both be slow and leak host-platform binaries into the container.
  rsync -a --delete --exclude=node_modules/ --exclude=.turbo/ /repo/ /work/repo/
else
  echo "[lane-entry] ${LANE_NAME}: rsync missing from image — falling back to a full copy (add rsync to ghcr.io/elizaos/certification-gpu)" >&2
  rm -rf /work/repo
  mkdir -p /work/repo
  cp -a /repo/. /work/repo/
fi

cd /work/repo
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-/cache/bun}"

echo "[lane-entry] ${LANE_NAME}: bun install (cache: ${BUN_INSTALL_CACHE_DIR})"
bun install --frozen-lockfile

echo "[lane-entry] ${LANE_NAME}: ${LANE_COMMAND}"
exec bash -c "${LANE_COMMAND}"
