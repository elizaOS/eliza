#!/usr/bin/env bash
# Lint pass over the variant tree: yaml, json, shebangs, exec bits, sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${HERE}"

fail=0

# JSON files parse.
while IFS= read -r f; do
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${f}" \
        || { echo "INVALID JSON: ${f}"; fail=1; }
done < <(find . -name "*.json" -not -path "./out/*" -not -path "./cache/*")

# Hooks must be executable and start with a shebang.
for f in config/hooks/normal/*.hook.chroot; do
    [ -e "${f}" ] || continue
    [ -x "${f}" ] || { echo "NOT EXECUTABLE: ${f}"; fail=1; }
    head -1 "${f}" | grep -q '^#!' || { echo "MISSING SHEBANG: ${f}"; fail=1; }
done

# Shell scripts pass `sh -n` parse.
while IFS= read -r f; do
    sh -n "${f}" 2>/dev/null || { echo "SH PARSE FAIL: ${f}"; fail=1; }
done < <(find scripts config/includes.chroot/usr/local/lib/elizaos -name "*.sh" -o -name "first-boot.sh" -o -name "start-launcher" -o -name "start-chat-overlay" 2>/dev/null)

# Systemd unit files have [Unit] + [Install] (or are .path/.target).
for f in $(find config/includes.chroot/etc/systemd -name "*.service" 2>/dev/null); do
    grep -q '^\[Unit\]' "${f}" || { echo "BAD UNIT: ${f}"; fail=1; }
done

if [ "${fail}" -eq 0 ]; then
    echo "OK: static smoke passed"
else
    echo "FAIL: static smoke had errors" >&2
fi
exit "${fail}"
