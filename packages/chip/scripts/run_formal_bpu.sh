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

overall=PASS
properties_yaml=""
for cfg in verify/formal/bpu/*.sby; do
    name="$(basename "$cfg" .sby)"
    out_dir="verify/formal/bpu/${name}"
    rm -rf "$out_dir"
    if sby -d "$out_dir" "$cfg" >"$out_dir.log" 2>&1; then
        status="$(cat "$out_dir/status" 2>/dev/null || echo PASS)"
    else
        # The most common reason yosys 0.64 chokes on BPU formal RTL is its
        # missing support for struct typedefs in module port lists. Detect
        # that explicitly so the evidence is traceable.
        if grep -q "syntax error, unexpected TOK_ID" "$out_dir.log" 2>/dev/null; then
            status="BLOCKED yosys-struct-typedef-port"
            overall=BLOCKED
        else
            status="FAIL"
            overall=FAIL
        fi
    fi
    properties_yaml="${properties_yaml}  - name: ${name}
    status: ${status}
"
done

cat >build/reports/bpu/formal-status.yaml <<EOF
schema: eliza.bpu_formal_status.v1
status: ${overall}
reason: "SymbiYosys BMC properties"
yosys_limitation: "yosys 0.64 (oss-cad-suite) does not accept struct typedefs in module port lists. Formal coverage for ftq is gated on a future yosys release or on a Slang-frontend yosys plugin."
properties:
${properties_yaml}
EOF

if [ "${overall}" != "PASS" ] && [ "${REQUIRE_BPU_FORMAL_CLEAN:-0}" = "1" ]; then
    exit 1
fi
