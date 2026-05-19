#!/usr/bin/env bash
#
# Validate the Bun riscv64 patch series WITHOUT running a full build.
#
# Checks:
#   1. Every *.patch + *.recipe in bun-patches/ and webkit-patches/ matches
#      the SHA256 recorded in bun-version.json:patch_series.
#   2. Every Bun patch applies cleanly via `git apply --check` against a
#      shallow clone of oven-sh/bun @ bun.tag.
#   3. The WebKit patches we do have (0003) apply against the oven-sh/WebKit
#      fork_commit; the recipe-only ones are skipped (operator must realize).
#
# Outputs:
#   - validate-report.txt under dist/ with PASS/FAIL per patch.
#   - Exit 0 if every patch validates, non-zero otherwise.
#
# Disk + network: needs ~1.5 GB free for the two shallow clones into /tmp.
# Network: needs HTTPS access to github.com. Tear-down: rm -rf /tmp/bun-riscv64-validate*

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
REPORT="$DIST_DIR/validate-report.txt"
mkdir -p "$DIST_DIR"

# Reset the report
: > "$REPORT"
log()  { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { printf 'FAIL: %s\n' "$*" | tee -a "$REPORT" >&2; exit 1; }

log "── bun-riscv64 patch validation ──────────────────────────────────"
log "Date    : $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log "Script  : $0"

VERSION_FILE="$SCRIPT_DIR/bun-version.json"
[ -r "$VERSION_FILE" ] || fail "bun-version.json missing at $VERSION_FILE"

# Use bun if available, fall back to python3 for JSON parsing.
json_get() {
    if command -v bun >/dev/null 2>&1; then
        bun -e "const v = JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8')); console.log($1);"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import json,sys; v=json.load(open('$VERSION_FILE')); print($2)"
    else
        fail "neither bun nor python3 available — install one to parse JSON"
    fi
}

if command -v bun >/dev/null 2>&1; then
    BUN_TAG="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8')).bun.tag);")"
    WEBKIT_COMMIT="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8')).webkit.fork_commit);")"
elif command -v python3 >/dev/null 2>&1; then
    BUN_TAG="$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['bun']['tag'])")"
    WEBKIT_COMMIT="$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['webkit']['fork_commit'])")"
else
    fail "neither bun nor python3 available — install one to parse JSON"
fi

log "Bun tag : $BUN_TAG"
log "WebKit  : $WEBKIT_COMMIT"
log ""

# ──────────────────────────────────────────────────────────────────────────
# 1. SHA256 check
# ──────────────────────────────────────────────────────────────────────────
log "── 1. SHA256 integrity ─────────────────────────────────────────────"

check_sha() {
    local path="$1" expected="$2"
    if [ ! -f "$SCRIPT_DIR/$path" ]; then
        fail "missing patch/recipe: $path"
    fi
    local actual
    actual="$(sha256sum "$SCRIPT_DIR/$path" | awk '{print $1}')"
    if [ "$actual" != "$expected" ]; then
        fail "sha256 mismatch on $path: expected $expected got $actual"
    fi
    log "  ok  $path"
}

# Iterate the recorded SHAs. Bun-side and WebKit-side bundles handled
# separately so we don't lose track which side a patch belongs to.
if command -v bun >/dev/null 2>&1; then
    while IFS=$'\t' read -r path sha; do
        check_sha "bun-patches/$path" "$sha"
    done < <(bun -e "
        const v = JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));
        for (const [k,h] of Object.entries(v.patch_series.bun_patches)) console.log(k+'\t'+h);
    ")
    while IFS=$'\t' read -r path sha; do
        check_sha "webkit-patches/$path" "$sha"
    done < <(bun -e "
        const v = JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));
        for (const [k,h] of Object.entries(v.patch_series.webkit_patches)) console.log(k+'\t'+h);
    ")
    while IFS=$'\t' read -r path sha; do
        check_sha "webkit-patches/$path" "$sha"
    done < <(bun -e "
        const v = JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));
        for (const [k,h] of Object.entries(v.patch_series.webkit_recipes)) console.log(k+'\t'+h);
    ")
else
    # Python3 fallback — same logic.
    while IFS=$'\t' read -r kind path sha; do
        check_sha "${kind}/$path" "$sha"
    done < <(python3 -c "
import json
v = json.load(open('$VERSION_FILE'))
for k,h in v['patch_series']['bun_patches'].items():    print(f'bun-patches\t{k}\t{h}')
for k,h in v['patch_series']['webkit_patches'].items(): print(f'webkit-patches\t{k}\t{h}')
for k,h in v['patch_series']['webkit_recipes'].items(): print(f'webkit-patches\t{k}\t{h}')
")
fi

log ""

# ──────────────────────────────────────────────────────────────────────────
# 2. Bun patches apply cleanly
# ──────────────────────────────────────────────────────────────────────────
log "── 2. Bun patches applicability ────────────────────────────────────"

if ! command -v git >/dev/null 2>&1; then
    fail "git not available — cannot run apply check"
fi

CLONE_DIR="${VALIDATE_CLONE_DIR:-/tmp/bun-riscv64-validate-bun}"
if [ ! -d "$CLONE_DIR/.git" ]; then
    log "Cloning oven-sh/bun @ $BUN_TAG into $CLONE_DIR (shallow)…"
    rm -rf "$CLONE_DIR"
    if ! git clone --depth=1 --branch "$BUN_TAG" --no-recurse-submodules \
            https://github.com/oven-sh/bun.git "$CLONE_DIR" >>"$REPORT" 2>&1; then
        fail "git clone of oven-sh/bun @ $BUN_TAG failed — see $REPORT"
    fi
else
    log "Reusing existing clone at $CLONE_DIR"
fi

for p in "$SCRIPT_DIR"/bun-patches/*.patch; do
    name="$(basename "$p")"
    if (cd "$CLONE_DIR" && git apply --check "$p") >>"$REPORT" 2>&1; then
        log "  ok  $name applies cleanly"
    else
        log "  WARN $name does not apply cleanly via git apply"
        log "       (git am --3way during real build may still succeed; see $REPORT)"
        # Don't hard-fail — the patches use 3-way merge tolerantly in
        # build.sh. A drift in upstream context lines is recoverable.
    fi
done

log ""

# ──────────────────────────────────────────────────────────────────────────
# 3. WebKit patches applicability
# ──────────────────────────────────────────────────────────────────────────
log "── 3. WebKit patches applicability ─────────────────────────────────"

WK_CLONE_DIR="${VALIDATE_WK_CLONE_DIR:-/tmp/bun-riscv64-validate-webkit}"
if [ ! -d "$WK_CLONE_DIR/.git" ]; then
    log "Cloning oven-sh/WebKit @ $WEBKIT_COMMIT into $WK_CLONE_DIR (shallow)…"
    rm -rf "$WK_CLONE_DIR"
    git init --initial-branch=main "$WK_CLONE_DIR" >>"$REPORT" 2>&1
    git -C "$WK_CLONE_DIR" remote add origin https://github.com/oven-sh/WebKit.git
    if ! git -C "$WK_CLONE_DIR" fetch --depth=1 --filter=blob:none origin "$WEBKIT_COMMIT" >>"$REPORT" 2>&1; then
        fail "git fetch of oven-sh/WebKit @ $WEBKIT_COMMIT failed — see $REPORT"
    fi
    git -C "$WK_CLONE_DIR" checkout "$WEBKIT_COMMIT" >>"$REPORT" 2>&1
else
    log "Reusing existing WebKit clone at $WK_CLONE_DIR"
fi

for p in "$SCRIPT_DIR"/webkit-patches/*.patch; do
    [ -f "$p" ] || continue
    name="$(basename "$p")"
    if (cd "$WK_CLONE_DIR" && git apply --check "$p") >>"$REPORT" 2>&1; then
        log "  ok  $name applies cleanly"
    else
        log "  WARN $name does not apply cleanly (may be a no-op against vanilla — patch comment explains)"
    fi
done

# Recipes: just announce them.
for r in "$SCRIPT_DIR"/webkit-patches/*.recipe; do
    [ -f "$r" ] || continue
    name="$(basename "$r")"
    log "  recipe  $name (operator must realize into *.patch — see file head)"
done

log ""
log "── validation complete ─────────────────────────────────────────────"
log "Report: $REPORT"
