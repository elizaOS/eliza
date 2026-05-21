#!/usr/bin/env bash
# Sparse-clone google-deepmind/mujoco_menagerie into vendor/ so the
# Unitree-profile generator can find MJCF/mesh assets. Only the robot
# directories we depend on are checked out (~50 MB instead of ~500 MB).
#
# Idempotent: re-runs are cheap.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${PKG_ROOT}/vendor/mujoco_menagerie"
REMOTE="${ELIZA_MENAGERIE_URL:-https://github.com/google-deepmind/mujoco_menagerie}"
SPARSE_DIRS=("unitree_g1" "unitree_h1" "unitree_go2" "berkeley_humanoid" "booster_t1")

if [[ ! -d "$TARGET/.git" ]]; then
  mkdir -p "$TARGET"
  git -C "$TARGET" init -q
  git -C "$TARGET" remote add origin "$REMOTE"
fi

git -C "$TARGET" config core.sparseCheckout true
{ printf '%s/\n' "${SPARSE_DIRS[@]}"; } > "$TARGET/.git/info/sparse-checkout"
git -C "$TARGET" fetch --depth=1 origin main
git -C "$TARGET" checkout -q FETCH_HEAD

echo "[sync_menagerie] $TARGET ready ($(du -sh "$TARGET" | cut -f1))"
