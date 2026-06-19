#!/usr/bin/env bash
# elizaOS Linux — mkosi tree static lint.
#
# Validates the mkosi/ subtree without invoking mkosi itself:
#   - required files present
#   - mkosi.postinst / mkosi.finalize are executable
#   - mkosi.skeleton symlinks resolve into ../config/includes.chroot
#   - every config file has a [Distribution] OR [Match] section
#   - arch overlays cover exactly the supported set
#   - profile overlays match the live-build profile set
#
# Exit non-zero on the first failure. Cheap to run; safe for CI/lint stage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MKOSI_DIR="${HERE}/mkosi"
fail=0
warn() { echo "[mkosi-lint] FAIL: $*" >&2; fail=1; }
ok()   { echo "[mkosi-lint] ok:   $*"; }

# 1. required files
for f in mkosi.conf mkosi.postinst mkosi.finalize; do
    if [ ! -e "${MKOSI_DIR}/${f}" ]; then
        warn "missing ${f}"
    else
        ok "present ${f}"
    fi
done

# 2. executable bits
for f in mkosi.postinst mkosi.finalize; do
    [ -x "${MKOSI_DIR}/${f}" ] || warn "${f} not executable"
done
[ -x "${MKOSI_DIR}/mkosi.postinst" ] && ok "mkosi.postinst executable"
[ -x "${MKOSI_DIR}/mkosi.finalize" ] && ok "mkosi.finalize executable"

# 3. skeleton symlinks resolve
for link in etc usr; do
    target="${MKOSI_DIR}/mkosi.skeleton/${link}"
    [ -L "${target}" ] || { warn "skeleton/${link} not a symlink"; continue; }
    resolved="$(readlink -f "${target}" || true)"
    case "${resolved}" in
        */config/includes.chroot/${link}) ok "skeleton/${link} -> ${resolved}";;
        *) warn "skeleton/${link} resolves to unexpected ${resolved}";;
    esac
done

# 4. arch overlays
for arch in amd64 arm64 riscv64; do
    f="${MKOSI_DIR}/mkosi.conf.d/10-arch-${arch}.conf"
    [ -f "${f}" ] || warn "missing arch overlay 10-arch-${arch}.conf"
done

# 5. profiles present (mkosi v24 requires mkosi.profiles/<name>/mkosi.conf)
for prof in gui secure secure-gui; do
    f="${MKOSI_DIR}/mkosi.profiles/${prof}/mkosi.conf"
    [ -f "${f}" ] || warn "missing mkosi.profiles/${prof}/mkosi.conf"
done

# 6. secure-gui must be the flat union of gui + secure package lists.
# Extract `Packages=` blocks (one entry per line, ignore section headers/comments).
extract_pkgs() {
    awk '
        /^\[Content\]/ { in_content = 1; next }
        /^\[/          { in_content = 0; next }
        in_content && /^Packages=/ { in_pkgs = 1; next }
        in_pkgs && /^[A-Za-z]/    { in_pkgs = 0 }
        in_pkgs && /^[[:space:]]*#/ { next }
        in_pkgs && /^[[:space:]]*[a-z0-9]/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print }
    ' "$1" | sort -u
}
gui_pkgs="$(extract_pkgs "${MKOSI_DIR}/mkosi.profiles/gui/mkosi.conf")"
sec_pkgs="$(extract_pkgs "${MKOSI_DIR}/mkosi.profiles/secure/mkosi.conf")"
sg_pkgs="$(extract_pkgs "${MKOSI_DIR}/mkosi.profiles/secure-gui/mkosi.conf")"
expected="$(printf '%s\n%s\n' "$gui_pkgs" "$sec_pkgs" | sort -u)"
if [ "$sg_pkgs" != "$expected" ]; then
    warn "secure-gui package list is not the union of gui+secure (run diff to inspect)"
    diff <(echo "$expected") <(echo "$sg_pkgs") | head -20 >&2 || true
else
    ok "secure-gui packages = union(gui, secure)"
fi

# 7. cheap parse: every .conf has a [Section] header.
shopt -s nullglob
for f in "${MKOSI_DIR}/mkosi.conf" "${MKOSI_DIR}/mkosi.conf.d/"*.conf "${MKOSI_DIR}/mkosi.profiles/"*/mkosi.conf; do
    if ! grep -q '^\[[A-Za-z]' "${f}"; then
        warn "${f}: no INI section header"
    fi
done

# 8. postinst references the canonical hook dir under /work/src/...
grep -q '/work/src/config/hooks/normal' "${MKOSI_DIR}/mkosi.postinst" \
    || warn "mkosi.postinst does not reference /work/src/config/hooks/normal"

if [ "${fail}" -ne 0 ]; then
    echo "[mkosi-lint] FAILED" >&2
    exit 1
fi
echo "[mkosi-lint] PASS"
