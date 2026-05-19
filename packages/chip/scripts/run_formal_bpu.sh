#!/usr/bin/env sh
# Formal runner for the BPU SymbiYosys properties. Mirrors
# scripts/run_formal.sh but iterates over verify/formal/bpu and produces a
# small JSON-friendly status YAML under build/reports/bpu/.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d "$REPO_ROOT/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_ROOT/external/oss-cad-suite/bin:$PATH"
fi

mkdir -p build/reports/bpu verify/formal/bpu

if ! command -v sby >/dev/null 2>&1; then
    cat <<EOF
STATUS: BLOCKED bpu.formal - sby is not installed. Use the chip-package
Nix/Docker shell or install SymbiYosys.
EOF
    cat >build/reports/bpu/formal-status.yaml <<EOF
schema: eliza.bpu_formal_status.v1
status: BLOCKED
reason: "no local sby"
remediation: "install SymbiYosys; re-run make formal-bpu"
EOF
    if [ "${REQUIRE_SBY:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

for cfg in verify/formal/bpu/*.sby; do
    name="$(basename "$cfg" .sby)"
    out_dir="verify/formal/bpu/${name}"
    rm -rf "$out_dir"
    sby -d "$out_dir" "$cfg"
done

cat >build/reports/bpu/formal-status.yaml <<EOF
schema: eliza.bpu_formal_status.v1
status: PASS
reason: "SymbiYosys BMC properties passed"
properties:
EOF
for cfg in verify/formal/bpu/*.sby; do
    name="$(basename "$cfg" .sby)"
    status_file="verify/formal/bpu/${name}/status"
    if [ -f "$status_file" ]; then
        echo "  - name: $name" >>build/reports/bpu/formal-status.yaml
        echo "    status: $(cat "$status_file")" >>build/reports/bpu/formal-status.yaml
    fi
done
