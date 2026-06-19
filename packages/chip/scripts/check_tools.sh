#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
strict=0
json=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --strict)
            strict=1
            ;;
        --json)
            json=1
            ;;
        -h|--help)
            cat <<EOF
usage: scripts/check_tools.sh [--strict] [--json]

  --strict  return non-zero when required fast-path tools or Python packages are missing
  --json    emit machine-readable tool status instead of the table
EOF
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
    shift
done

if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi
if [ -d "$repo_dir/.venv/bin" ]; then
    PATH="$repo_dir/.venv/bin:$PATH"
fi
if [ -d "$repo_dir/tools/bin" ]; then
    PATH="$repo_dir/tools/bin:$PATH"
fi
if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/KiCad/KiCad.app/Contents/MacOS" ]; then
    PATH="/Applications/KiCad/KiCad.app/Contents/MacOS:$PATH"
fi

missing_required=0
records="$(mktemp "${TMPDIR:-/tmp}/eliza-tools.XXXXXX")"
trap 'rm -f "$records"' EXIT

record_status() {
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$1" "$2" "$3" "$4" "$5" "$6" >>"$records"
}

check_tool() {
    tool="$1"
    tier="$2"
    gate="$3"
    required="$4"
    if command -v "$tool" >/dev/null 2>&1; then
        path_or_status="$(command -v "$tool")"
        record_status "$tool" "PASS" "$tier" "$gate" "$path_or_status" "$required"
        if [ "$json" -eq 0 ]; then
            printf "%-22s %-8s %-12s %-28s %s\n" "$tool" "PASS" "$tier" "$gate" "$path_or_status"
        fi
    else
        if [ "$required" = "required" ]; then
            status="FAIL"
        else
            status="BLOCK"
        fi
        record_status "$tool" "$status" "$tier" "$gate" "MISSING" "$required"
        if [ "$json" -eq 0 ]; then
            printf "%-22s %-8s %-12s %-28s MISSING\n" "$tool" "$status" "$tier" "$gate"
        fi
        if [ "$required" = "required" ]; then
            missing_required=1
        fi
    fi
}

check_python_package() {
    module="$1"
    dist="$2"
    gate="$3"
    if "$python_bin" - "$module" "$dist" >/dev/null 2>&1 <<'PY'
import importlib.metadata
import sys
module = sys.argv[1]
dist = sys.argv[2]
try:
    __import__(module)
    print(importlib.metadata.version(dist))
except Exception:
    raise SystemExit(1)
PY
    then
        version="$("$python_bin" - "$module" "$dist" <<'PY'
import importlib.metadata
import sys
__import__(sys.argv[1])
print(importlib.metadata.version(sys.argv[2]))
PY
)"
        record_status "$dist" "PASS" "python" "$gate" "$version" "required"
        if [ "$json" -eq 0 ]; then
            printf "%-22s %-8s %-12s %-28s %s\n" "$dist" "PASS" "python" "$gate" "$version"
        fi
    else
        record_status "$dist" "FAIL" "python" "$gate" "MISSING" "required"
        if [ "$json" -eq 0 ]; then
            printf "%-22s %-8s %-12s %-28s MISSING\n" "$dist" "FAIL" "python" "$gate"
        fi
        missing_required=1
    fi
}

if [ "$json" -eq 0 ]; then
    printf "%-22s %-8s %-12s %-28s %s\n" "TOOL" "STATUS" "TIER" "GATE" "PATH_OR_STATUS"
    printf "%-22s %-8s %-12s %-28s %s\n" "----" "------" "----" "----" "--------------"
fi

check_tool python3 fast "repo scripts/docs" required
check_tool pip3 fast ".venv bootstrap" required
check_tool make fast "documented gates" required
check_tool git fast "source/upstream refs" required
check_tool ruff fast "python lint/format" required
check_tool mypy fast "python typecheck" required
check_tool shellcheck fast "shell lint" optional
check_tool yamllint fast "yaml lint" optional
check_tool jq fast "json inspection" optional
check_tool dtc fast "devicetree syntax" optional
check_tool verilator fast "smoke/cocotb/verilator" optional
check_tool yosys fast "synth/formal fallback" optional
check_tool yosys-smtbmc fast "formal fallback" optional
check_tool z3 fast "formal solver" optional
check_tool iverilog fast "optional RTL sims" optional
check_tool qemu-system-riscv64 fast "qemu-check" optional
check_tool docker host "container baseline" optional
check_tool nix host "dev shell/flake" optional
check_tool cmake host "native builds" optional
check_tool ninja host "native builds" optional
check_tool rsync host "external BSP imports" optional
check_tool java host "AOSP builds" optional
check_tool javac host "AOSP builds" optional
check_tool repo heavy "AOSP checkout sync" optional
check_tool adb heavy "Android/Cuttlefish tests" optional
check_tool cvd heavy "Cuttlefish launch" optional
check_tool launch_cvd heavy "legacy Cuttlefish launch" optional
check_tool dtc heavy "Linux devicetree build" optional
check_tool bc heavy "Linux kernel build" optional
check_tool flex heavy "Linux/AOSP builds" optional
check_tool bison heavy "Linux/AOSP builds" optional
check_tool riscv64-unknown-elf-gcc heavy "qemu firmware build" optional
check_tool riscv64-linux-gnu-gcc heavy "Linux/Buildroot cross build" optional
check_tool gtkwave host "wave debug" optional
check_tool sby heavy "strict formal" optional
check_tool boolector heavy "legacy formal solver" optional
check_tool openroad heavy "PD implementation" optional
check_tool openlane heavy "PD implementation" optional
check_tool nextpnr-ecp5 heavy "FPGA bitstream" optional
check_tool ecppack heavy "FPGA bitstream" optional
check_tool klayout heavy "layout review/DRC" optional
check_tool magic heavy "layout DRC/LVS" optional
check_tool netgen heavy "LVS" optional
check_tool renode heavy "renode-check" optional
check_tool kicad-cli heavy "board artifacts" optional
check_tool fio heavy "storage benchmarks" optional
check_tool bw_mem heavy "lmbench bandwidth" optional
check_tool lat_mem_rd heavy "lmbench latency" optional
check_tool coremark heavy "CoreMark benchmark" optional
check_tool stream_c.exe heavy "STREAM benchmark" optional
check_tool benchmark_model heavy "TFLite benchmark" optional
check_tool openocd heavy "board debug probes" optional
check_tool sigrok-cli heavy "board signal capture" optional

if [ -x "$repo_dir/.venv/bin/python" ]; then
    python_bin="$repo_dir/.venv/bin/python"
    record_status ".venv" "PASS" "python" "isolated repo env" "$repo_dir/.venv" "optional"
    if [ "$json" -eq 0 ]; then
        printf "%-22s %-8s %-12s %-28s %s\n" ".venv" "PASS" "python" "isolated repo env" "$repo_dir/.venv"
    fi
else
    python_bin="$(command -v python3)"
    record_status ".venv" "BLOCK" "python" "isolated repo env" "MISSING" "optional"
    if [ "$json" -eq 0 ]; then
        printf "%-22s %-8s %-12s %-28s %s\n" ".venv" "BLOCK" "python" "isolated repo env" "MISSING"
    fi
fi

check_python_package cocotb cocotb "cocotb"
check_python_package pytest pytest "pytest/docs"
check_python_package numpy numpy "runtime/tests"
check_python_package yaml PyYAML "yaml checks"
check_python_package ruff ruff "python lint/format"
check_python_package mypy mypy "python typecheck"
check_python_package yamllint yamllint "yaml lint"

if [ "$json" -eq 1 ]; then
    python_for_json="$(command -v python3)"
    "$python_for_json" - "$records" "$strict" "$missing_required" <<'PY'
import json
import sys
from pathlib import Path

records = []
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name, status, tier, gate, path_or_status, required = line.split("\t")
    records.append(
        {
            "name": name,
            "status": status,
            "tier": tier,
            "gate": gate,
            "path_or_status": path_or_status,
            "required": required == "required",
        }
    )

summary = {
    "pass": sum(1 for item in records if item["status"] == "PASS"),
    "block": sum(1 for item in records if item["status"] == "BLOCK"),
    "fail": sum(1 for item in records if item["status"] == "FAIL"),
}
print(
    json.dumps(
        {
            "schema": "eliza.tool_status.v1",
            "strict": sys.argv[2] == "1",
            "missing_required": sys.argv[3] != "0",
            "summary": summary,
            "tools": records,
        },
        indent=2,
        sort_keys=True,
    )
)
PY
fi

if [ "$strict" -eq 1 ] && [ "$missing_required" -ne 0 ]; then
    echo "Required fast-path tools or Python packages are missing." >&2
    exit 1
fi
