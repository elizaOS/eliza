#!/usr/bin/env bash
# Apply repo-local patches to the external/cva6/cva6 checkout.
#
# Patches live under patches/cva6/*.patch (tracked in this repo) — the
# external/cva6/cva6 checkout itself sits under the gitignored
# external/ tree, so the patches are carried alongside the chip
# package, not inside the CVA6 source tree.
#
# The script is idempotent: each patch is checked first with
# `git apply --reverse --check`; if it already applies in reverse the
# patch is already on the tree and we skip it.  This lets the script
# be safely re-run from any Makefile target before invoking Verilator
# on the CVA6 sources.
#
# Why this exists: the upstream openhwgroup/cva6 source tree (originally
# diagnosed at v5.3.0; pin since advanced to master HEAD via
# external/cva6/pin-manifest.json) contains constructs (currently
# btb.sv:188's whole-array NBA on a 2D unpacked struct array) that
# Verilator 5.049 cannot lower.  We carry minimal workarounds locally —
# one patch per upstream issue — and apply them just-in-time to keep the
# upstream checkout pristine on disk until the simulator builds need to
# consume it.  Re-verify patches still apply after each pin bump.
#
# Invocation:
#   scripts/apply_cva6_patches.sh           # apply all patches
#   scripts/apply_cva6_patches.sh --revert  # revert all patches
#   scripts/apply_cva6_patches.sh --status  # report applied/missing
#
# Exit codes:
#   0  all patches applied (or reverted) cleanly
#   1  patch failed to apply / revert
#   2  no patches to apply (still considered success-zero)

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_DIR="$REPO_ROOT/patches/cva6"
CVA6_DIR="$REPO_ROOT/external/cva6/cva6"

if [ ! -d "$CVA6_DIR" ]; then
    echo "apply_cva6_patches: CVA6 checkout missing at $CVA6_DIR" >&2
    exit 1
fi
if [ ! -d "$PATCH_DIR" ]; then
    echo "apply_cva6_patches: patch directory missing at $PATCH_DIR" >&2
    exit 1
fi

mode="apply"
case "${1:-}" in
    --revert) mode="revert" ;;
    --status) mode="status" ;;
    "") ;;
    *) echo "apply_cva6_patches: unknown argument: $1" >&2; exit 1 ;;
esac

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
if [ "${#patches[@]}" -eq 0 ]; then
    echo "apply_cva6_patches: no patches in $PATCH_DIR (nothing to do)"
    exit 0
fi

cd "$CVA6_DIR"

for patch in "${patches[@]}"; do
    name="$(basename "$patch")"
    if git apply --reverse --check "$patch" >/dev/null 2>&1; then
        # Patch is already applied (reverse-checks clean).
        case "$mode" in
            apply)
                echo "apply_cva6_patches: SKIP $name (already applied)"
                ;;
            revert)
                if git apply --reverse "$patch"; then
                    echo "apply_cva6_patches: REVERTED $name"
                else
                    echo "apply_cva6_patches: FAIL reverting $name" >&2
                    exit 1
                fi
                ;;
            status)
                echo "apply_cva6_patches: APPLIED $name"
                ;;
        esac
    elif git apply --check "$patch" >/dev/null 2>&1; then
        # Patch applies forward (tree is clean).
        case "$mode" in
            apply)
                if git apply "$patch"; then
                    echo "apply_cva6_patches: APPLIED $name"
                else
                    echo "apply_cva6_patches: FAIL applying $name" >&2
                    exit 1
                fi
                ;;
            revert)
                echo "apply_cva6_patches: SKIP $name (not currently applied)"
                ;;
            status)
                echo "apply_cva6_patches: MISSING $name"
                ;;
        esac
    else
        echo "apply_cva6_patches: FAIL $name does not apply forward or in reverse — checkout drifted from pinned commit?" >&2
        echo "  patch: $patch" >&2
        echo "  cva6 HEAD: $(git rev-parse HEAD)" >&2
        exit 1
    fi
done

exit 0
