#!/usr/bin/env sh
# record_tool_versions.sh
#
# Emit a focused tool-version manifest for the release-gate toolchain set.
# Complements scripts/tool_versions.sh (which records the full host probe).
# This script is intentionally fail-soft per tool: a missing tool is recorded
# as MISSING rather than failing the script, so the manifest can always be
# attached as CI evidence even from a partially-provisioned host.

set -u

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
out_dir="$repo_dir/build/reports"
out_file="$out_dir/tool_versions.txt"
sidecar="$out_dir/tool_versions_release_gate.txt"
mkdir -p "$out_dir"

# Required tool set per the toolchain reproducibility policy
# (docs/toolchain/reproducibility.md).
TOOLS="python3 gcc riscv64-unknown-elf-gcc verilator yosys nextpnr-ecp5 ecppack sby qemu-system-riscv64"

emit_one() {
    name="$1"
    bin="$(command -v "$name" 2>/dev/null || true)"
    if [ -z "$bin" ]; then
        printf "%s\tMISSING\tMISSING\n" "$name"
        return
    fi
    case "$name" in
        ecppack)
            ver="$("$bin" --help 2>&1 | head -n 1 || true)"
            ;;
        sby)
            ver="$("$bin" --version 2>&1 | head -n 1 || true)"
            ;;
        *)
            ver="$("$bin" --version 2>&1 | head -n 1 || true)"
            ;;
    esac
    [ -z "$ver" ] && ver="VERSION_UNAVAILABLE"
    printf "%s\t%s\t%s\n" "$name" "$bin" "$ver"
}

manifest_body() {
    printf "# record_tool_versions manifest\n"
    printf "# timestamp_utc=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf "# host=%s\n" "$(uname -a 2>/dev/null || echo UNKNOWN)"
    printf "# format: <tool>\\t<path|MISSING>\\t<version|MISSING|VERSION_UNAVAILABLE>\n"
    for t in $TOOLS; do
        emit_one "$t"
    done
}

# Always write the sidecar so the broader scripts/tool_versions.sh probe
# (which writes the same canonical out_file) is not destroyed when both run.
manifest_body > "$sidecar"

# Only overwrite the canonical out_file if it doesn't already contain a fuller
# probe from scripts/tool_versions.sh — preserve whichever has more lines.
if [ ! -f "$out_file" ] || [ "$(wc -l < "$out_file" 2>/dev/null || echo 0)" -lt "$(wc -l < "$sidecar")" ]; then
    cp "$sidecar" "$out_file"
fi

echo "Recorded $sidecar"
echo "Canonical manifest: $out_file"
