#!/usr/bin/env bash
# Run the eliza-e1 tier-2 Linux boot smoke test under Renode.
#
# Prereqs (produced by sibling worktrees):
#   - external/opensbi/build/platform/eliza/firmware/fw_payload.elf
#     (built from sw/opensbi/platform/eliza/* copied into the opensbi tree)
#   - external/linux/arch/riscv/boot/Image
#   - build/initramfs/eliza_tier2.cpio.gz
#
# Renode is expected on PATH (`brew install --cask renode` on macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOG_DIR="build/sim/renode"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/tier2.log"

if ! command -v renode-test >/dev/null 2>&1; then
  echo "renode-test not found. Install with: brew install --cask renode" >&2
  exit 127
fi

PAYLOAD="external/opensbi/build/platform/eliza/firmware/fw_payload.elf"
if [[ ! -f "$PAYLOAD" ]]; then
  echo "Missing $PAYLOAD — build OpenSBI for the eliza platform first" >&2
  echo "(see sw/opensbi/platform/eliza/README and docs/sim/renode-tier2-recipe.md)" >&2
  exit 2
fi

echo "[run_renode_tier2] logging to $LOG"
renode-test sim/renode/eliza_e1_tier2.robot 2>&1 | tee "$LOG"
