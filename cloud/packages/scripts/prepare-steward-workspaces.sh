#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STEWARD_REPO_URL="${STEWARD_REPO_URL:-https://github.com/Steward-Fi/steward.git}"
STEWARD_REF="${STEWARD_REF:-cloudflare-workers-adapter}"
STEWARD_DIR="${STEWARD_DIR:-$REPO_ROOT/packages/steward}"
PATCH_FILE="$REPO_ROOT/packages/patches/steward-cloud-workspaces.patch"

mkdir -p "$(dirname "$STEWARD_DIR")"

need_clone() {
  [ ! -f "$STEWARD_DIR/packages/api/package.json" ]
}

if need_clone; then
  rm -rf "$STEWARD_DIR"
  git clone --filter=blob:none "$STEWARD_REPO_URL" "$STEWARD_DIR"
fi

HEAD_SHORT=""
if [ -d "$STEWARD_DIR/.git" ]; then
  git -C "$STEWARD_DIR" fetch --depth=1 origin "$STEWARD_REF"
  git -C "$STEWARD_DIR" checkout --force FETCH_HEAD
  git -C "$STEWARD_DIR" clean -fdx

  if [ -f "$PATCH_FILE" ]; then
    if git -C "$STEWARD_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
      echo "Steward workspace patch already applied."
    else
      git -C "$STEWARD_DIR" apply --check "$PATCH_FILE"
      git -C "$STEWARD_DIR" apply "$PATCH_FILE"
    fi
  fi
  HEAD_SHORT="$(git -C "$STEWARD_DIR" rev-parse --short HEAD)"
else
  if [ -f "$PATCH_FILE" ]; then
    echo "[prepare-steward-workspaces] $PATCH_FILE exists but Steward at $STEWARD_DIR has no .git; skipping git apply (merge the patch into the vendored tree or use a git checkout)." >&2
  fi
  HEAD_SHORT="vendored"
fi

for package_name in api auth db policy-engine redis shared vault webhooks; do
  package_dir="$STEWARD_DIR/packages/$package_name"
  if [ ! -f "$package_dir/package.json" ]; then
    echo "Missing Steward workspace package: $package_dir" >&2
    exit 1
  fi
done

echo "Prepared Steward workspaces at $STEWARD_DIR ($HEAD_SHORT)"
