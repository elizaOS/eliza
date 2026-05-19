#!/usr/bin/env sh
# bootstrap_ibex.sh - fetch the pinned lowRISC Ibex source into external/ibex/ibex
# and rewrite external/ibex/pin-manifest.json with the resolved commit SHA so
# scripts/check_ibex_pin.py flips BLOCKED -> PASS.
#
# Ibex upstream does not cut release tags; the manifest pins a branch HEAD
# snapshot (upstream_ref_kind == "branch_head_snapshot") plus a frozen SHA.
# This script clones the branch, sets the working tree to the pinned SHA, and
# fails closed if the SHA is no longer reachable.
#
# Fails closed if git or network is absent.
#
# Usage:
#   scripts/bootstrap_ibex.sh                  # use manifest pin
#   IBEX_REFRESH_PIN=1 scripts/bootstrap_ibex.sh
#       (advance the pinned SHA to whatever the branch HEAD is right now)
#   IBEX_DRY_RUN=1 scripts/bootstrap_ibex.sh   # validate prereqs, do not fetch
set -eu

REPO_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_DIR"

MANIFEST="external/ibex/pin-manifest.json"
CHECKOUT="external/ibex/ibex"

if [ ! -f "$MANIFEST" ]; then
    echo "bootstrap_ibex: manifest missing: $MANIFEST" >&2
    exit 2
fi

if ! command -v git >/dev/null 2>&1; then
    echo "bootstrap_ibex: git not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "bootstrap_ibex: python3 not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

REPO_URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_repo"])' "$MANIFEST")"
REF="$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m.get("upstream_ref","refs/heads/master"))' "$MANIFEST")"
PIN_SHA="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_commit_pinned"])' "$MANIFEST")"

if [ "${IBEX_DRY_RUN:-0}" = "1" ]; then
    echo "bootstrap_ibex: dry-run OK"
    echo "  repo_url   = $REPO_URL"
    echo "  manifest   = $MANIFEST"
    echo "  checkout   = $CHECKOUT"
    echo "  ref        = $REF"
    echo "  pin_sha    = $PIN_SHA"
    exit 0
fi

if ! git ls-remote --refs --exit-code "$REPO_URL" "$REF" >/dev/null 2>&1; then
    echo "bootstrap_ibex: cannot reach $REPO_URL ($REF); fail-closed" >&2
    exit 1
fi

mkdir -p external/ibex

BRANCH_NAME="${REF##refs/heads/}"
if [ ! -d "$CHECKOUT/.git" ]; then
    git clone --branch "$BRANCH_NAME" "$REPO_URL" "$CHECKOUT"
else
    git -C "$CHECKOUT" fetch origin "$BRANCH_NAME"
fi

if [ "${IBEX_REFRESH_PIN:-0}" = "1" ]; then
    PIN_SHA="$(git -C "$CHECKOUT" rev-parse "origin/$BRANCH_NAME")"
    echo "bootstrap_ibex: refreshing pin to current $BRANCH_NAME HEAD = $PIN_SHA"
fi

if ! git -C "$CHECKOUT" cat-file -e "$PIN_SHA^{commit}" 2>/dev/null; then
    echo "bootstrap_ibex: pinned SHA $PIN_SHA not reachable in checkout; fail-closed" >&2
    exit 1
fi

git -C "$CHECKOUT" checkout --detach "$PIN_SHA"
RESOLVED_SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
echo "bootstrap_ibex: resolved HEAD = $RESOLVED_SHA"

python3 - "$MANIFEST" "$RESOLVED_SHA" <<'PY'
import json, sys
from pathlib import Path
manifest_path = Path(sys.argv[1])
new_sha = sys.argv[2]
m = json.loads(manifest_path.read_text())
m["upstream_commit_pinned"] = new_sha
manifest_path.write_text(json.dumps(m, indent=2) + "\n")
print(f"bootstrap_ibex: wrote SHA {new_sha} into {manifest_path}")
PY

python3 scripts/check_ibex_pin.py
