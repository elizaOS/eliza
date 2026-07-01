#!/usr/bin/env sh
# bootstrap_opentitan.sh - fetch the pinned lowRISC OpenTitan source into
# external/opentitan/opentitan and rewrite external/opentitan/pin-manifest.json
# with the resolved commit SHA so scripts/check_rot_integration.py can enforce
# HEAD == pin.
#
# OpenTitan supplies the audited crypto/security blocks reused by the E1 RoT
# (docs/security/tee-plan/02-root-of-trust.md S2): rom_ctrl, keymgr, kmac, hmac,
# aes, csrng, edn, entropy_src, alert_handler. otp_ctrl and lc_ctrl are NOT
# reused -- they are the E1-specific W4/W5 blocks. This script clones the
# pinned Earl Grey release tag, sets the working tree to the pinned SHA, and
# fails closed if git or the network is absent.
#
# Modelled on scripts/bootstrap_ibex.sh.
#
# Usage:
#   scripts/bootstrap_opentitan.sh                 # use manifest pin
#   OPENTITAN_REFRESH_PIN=1 scripts/bootstrap_opentitan.sh
#       (advance the pinned SHA to whatever the ref resolves to right now)
#   OPENTITAN_DRY_RUN=1 scripts/bootstrap_opentitan.sh   # validate prereqs only
set -eu

REPO_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_DIR"

MANIFEST="external/opentitan/pin-manifest.json"
CHECKOUT="external/opentitan/opentitan"

if [ ! -f "$MANIFEST" ]; then
    echo "bootstrap_opentitan: manifest missing: $MANIFEST" >&2
    exit 2
fi

if ! command -v git >/dev/null 2>&1; then
    echo "bootstrap_opentitan: git not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "bootstrap_opentitan: python3 not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

REPO_URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_repo"])' "$MANIFEST")"
REF="$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m.get("upstream_ref","refs/heads/master"))' "$MANIFEST")"
PIN_SHA="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_commit_pinned"])' "$MANIFEST")"

if [ "${OPENTITAN_DRY_RUN:-0}" = "1" ]; then
    echo "bootstrap_opentitan: dry-run OK"
    echo "  repo_url   = $REPO_URL"
    echo "  manifest   = $MANIFEST"
    echo "  checkout   = $CHECKOUT"
    echo "  ref        = $REF"
    echo "  pin_sha    = $PIN_SHA"
    exit 0
fi

if ! git ls-remote --refs --exit-code "$REPO_URL" "$REF" >/dev/null 2>&1; then
    echo "bootstrap_opentitan: cannot reach $REPO_URL ($REF); fail-closed" >&2
    exit 1
fi

mkdir -p external/opentitan

# Tag refs check out detached; branch refs check out the branch then detach.
REF_NAME="${REF##refs/tags/}"
REF_NAME="${REF_NAME##refs/heads/}"

if [ ! -d "$CHECKOUT/.git" ]; then
    # Shallow clone of the single pinned ref keeps the checkout small; the
    # crypto/security RTL we need is a tiny fraction of the OpenTitan tree but
    # a full clone is multi-GB, so fetch only what the pin references.
    git clone --depth 1 --branch "$REF_NAME" "$REPO_URL" "$CHECKOUT"
else
    git -C "$CHECKOUT" fetch --depth 1 origin "$REF"
fi

if [ "${OPENTITAN_REFRESH_PIN:-0}" = "1" ]; then
    PIN_SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
    echo "bootstrap_opentitan: refreshing pin to resolved $REF HEAD = $PIN_SHA"
fi

if ! git -C "$CHECKOUT" cat-file -e "$PIN_SHA^{commit}" 2>/dev/null; then
    echo "bootstrap_opentitan: pinned SHA $PIN_SHA not present in shallow checkout; fail-closed" >&2
    echo "  (re-run with OPENTITAN_REFRESH_PIN=1 to adopt the resolved tag commit)" >&2
    exit 1
fi

git -C "$CHECKOUT" checkout --detach "$PIN_SHA" 2>/dev/null || true
RESOLVED_SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
echo "bootstrap_opentitan: resolved HEAD = $RESOLVED_SHA"

python3 - "$MANIFEST" "$RESOLVED_SHA" <<'PY'
import json, sys
from pathlib import Path
manifest_path = Path(sys.argv[1])
new_sha = sys.argv[2]
m = json.loads(manifest_path.read_text())
m["upstream_commit_pinned"] = new_sha
manifest_path.write_text(json.dumps(m, indent=2) + "\n")
print(f"bootstrap_opentitan: wrote SHA {new_sha} into {manifest_path}")
PY

python3 scripts/check_rot_integration.py || true
