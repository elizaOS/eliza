#!/usr/bin/env sh
# bootstrap_opensbi.sh - fetch the pinned OpenSBI tag into external/opensbi/opensbi
# and rewrite external/opensbi/pin-manifest.json with the resolved commit SHA so
# scripts/check_opensbi_pin.py flips BLOCKED -> PASS.
#
# Fails closed if git or network is absent.
#
# Usage:
#   scripts/bootstrap_opensbi.sh                  # uses manifest tag
#   OPENSBI_TAG=v1.8.1 scripts/bootstrap_opensbi.sh # override tag
#   OPENSBI_DRY_RUN=1 scripts/bootstrap_opensbi.sh
set -eu

REPO_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_DIR"

MANIFEST="external/opensbi/pin-manifest.json"
CHECKOUT="external/opensbi/opensbi"

if [ ! -f "$MANIFEST" ]; then
    echo "bootstrap_opensbi: manifest missing: $MANIFEST" >&2
    exit 2
fi

if ! command -v git >/dev/null 2>&1; then
    echo "bootstrap_opensbi: git not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "bootstrap_opensbi: python3 not installed; cannot proceed (fail-closed)" >&2
    exit 2
fi

REPO_URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_repo"])' "$MANIFEST")"
MANIFEST_TAG="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["upstream_tag_pinned"])' "$MANIFEST")"
OPENSBI_TAG="${OPENSBI_TAG:-$MANIFEST_TAG}"

if [ "${OPENSBI_DRY_RUN:-0}" = "1" ]; then
    echo "bootstrap_opensbi: dry-run OK"
    echo "  repo_url   = $REPO_URL"
    echo "  manifest   = $MANIFEST"
    echo "  checkout   = $CHECKOUT"
    echo "  tag        = $OPENSBI_TAG"
    exit 0
fi

if ! git ls-remote --refs --exit-code "$REPO_URL" "refs/tags/$OPENSBI_TAG" >/dev/null 2>&1; then
    echo "bootstrap_opensbi: cannot reach $REPO_URL (refs/tags/$OPENSBI_TAG); fail-closed" >&2
    exit 1
fi

mkdir -p external/opensbi

if [ ! -d "$CHECKOUT/.git" ]; then
    git clone --depth 1 --branch "$OPENSBI_TAG" "$REPO_URL" "$CHECKOUT"
else
    (cd "$CHECKOUT" && git fetch --tags --depth 1 origin "$OPENSBI_TAG")
fi

RESOLVED_SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
echo "bootstrap_opensbi: resolved HEAD = $RESOLVED_SHA"

python3 - "$MANIFEST" "$RESOLVED_SHA" <<'PY'
import json, sys
from pathlib import Path
manifest_path = Path(sys.argv[1])
new_sha = sys.argv[2]
m = json.loads(manifest_path.read_text())
m["upstream_commit_pinned"] = new_sha
manifest_path.write_text(json.dumps(m, indent=2) + "\n")
print(f"bootstrap_opensbi: wrote SHA {new_sha} into {manifest_path}")
PY

python3 scripts/check_opensbi_pin.py
