#!/bin/sh
# Fail-closed phone/prototype Dhrystone harness placeholder.
#
# This intentionally writes a separate L5/L6 artifact from the CVA6 Verilator
# result so phone-class claim gates cannot accidentally consume L1 simulator
# evidence.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/dhrystone"
RESULT_JSON="${RESULTS_DIR}/l5_l6_result.json"
DUT="${E1_DHRYSTONE_DUT:-prototype}"
mkdir -p "${RESULTS_DIR}"

now() { date -u +%FT%TZ; }

is_sha256() {
    case "$1" in
        *[!0123456789abcdefABCDEF]*|"") return 1 ;;
    esac
    [ "${#1}" -eq 64 ]
}

json_quote() {
    python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
}

is_positive_number() {
    python3 - "$1" <<'PY'
import math
import re
import sys

value = sys.argv[1]
if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
    raise SystemExit(1)
number = float(value)
raise SystemExit(0 if math.isfinite(number) and number > 0 else 1)
PY
}

path_under_root() {
    python3 - "$ROOT" "$1" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
path = Path(sys.argv[2]).resolve()
try:
    path.relative_to(root)
except ValueError:
    raise SystemExit(1)
raise SystemExit(0)
PY
}

write_passed_from_transcript() {
    raw_output=${E1_DHRYSTONE_RAW_OUTPUT:-}
    runner=${E1_DHRYSTONE_TARGET_RUNNER:-${DUT}}
    metadata=${E1_DHRYSTONE_TARGET_METADATA:-}
    dut_json=$(printf '%s' "${DUT}" | json_quote)

    if [ -z "${raw_output}" ] || [ ! -f "${raw_output}" ]; then
        return 1
    fi
    raw_output_json=$(printf '%s' "${raw_output}" | json_quote)
    if ! path_under_root "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_DHRYSTONE_RAW_OUTPUT must be an archived artifact under packages/chip before a Dhrystone L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json}
  },
  "blocked_requirements": [
    {"name": "artifacts.raw_output", "reason": "raw target output must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    case "${runner}" in
        prototype|silicon|phone)
            ;;
        *)
            cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_DHRYSTONE_TARGET_RUNNER must identify prototype, silicon, or phone before a Dhrystone L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "blocked_requirements": [
    {"name": "target.runner.dhrystone", "reason": "invalid target runner selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target_execution.runner", "reason": "must be prototype, silicon, or phone", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
            return 0
            ;;
    esac

    if [ -z "${metadata}" ] || [ ! -f "${metadata}" ]; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_DHRYSTONE_TARGET_METADATA must point at real target metadata before a Dhrystone L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "blocked_requirements": [
    {"name": "target.metadata", "reason": "missing target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "metadata must include calibrated clock evidence for DMIPS/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi
    metadata_json=$(printf '%s' "${metadata}" | json_quote)
    if ! path_under_root "${metadata}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_DHRYSTONE_TARGET_METADATA must be an archived artifact under packages/chip before a Dhrystone L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "target_metadata": ${metadata_json}
  },
  "blocked_requirements": [
    {"name": "artifacts.target_metadata", "reason": "target metadata must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    raw_sha=$(sha256sum "${raw_output}" | awk '{print $1}')
    metadata_sha=$(sha256sum "${metadata}" | awk '{print $1}')
    runner_json=$(printf '%s' "${runner}" | json_quote)
    metadata_errors=$(python3 "${ROOT}/scripts/target_metadata_contract.py" "${metadata}" --runner "${runner}" --artifact-root "${ROOT}" --required-calibration-asset dhrystone_binary 2>&1) || {
        metadata_errors_json=$(printf '%s' "${metadata_errors}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "Dhrystone target metadata does not satisfy the L5/L6 metadata contract",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "target.metadata.contract", "reason": ${metadata_errors_json}, "resolution": "Provide target metadata that satisfies the L5/L6 contract and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "requires calibrated clock-source asset with sha256 and evidence", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.power_meter", "reason": "requires calibrated power-meter asset with sha256 and evidence", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.metadata.sections", "reason": "requires software, clocks, memory, power, thermal, process, and calibration sections", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    }
    dhrystones_per_second=$(awk -F: 'tolower($1) ~ /dhrystones[ \t]+per[ \t]+second/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "${raw_output}")
    dmips_per_mhz=$(awk -F: 'tolower($1) ~ /dmips\/mhz/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "${raw_output}")

    if ! grep -qi 'Dhrystone Benchmark' "${raw_output}" || ! grep -qi 'Dhrystones per Second' "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "Dhrystone target transcript is present but lacks required Dhrystone run markers",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "transcript.dhrystone_markers", "reason": "requires Dhrystone Benchmark and Dhrystones per Second markers from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    if [ -z "${dhrystones_per_second}" ] || [ -z "${dmips_per_mhz}" ] || ! is_positive_number "${dhrystones_per_second}" || ! is_positive_number "${dmips_per_mhz}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "Dhrystone target transcript is present but does not contain parseable Dhrystones per Second and DMIPS/MHz lines",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "metrics", "reason": "requires parseable Dhrystones per Second and DMIPS/MHz from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    if ! is_sha256 "${raw_sha}" || ! is_sha256 "${metadata_sha}"; then
        echo "STATUS: FAIL cpu.dhrystone_l5_l6 - internal sha256 calculation failed" >&2
        exit 1
    fi

    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "passed",
  "provenance": "target-measured",
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "target_execution": {
    "runner": ${runner_json},
    "transcript_sha256": "${raw_sha}"
  },
  "metrics": {
    "dhrystones_per_second": ${dhrystones_per_second},
    "dmips_per_mhz": ${dmips_per_mhz}
  }
}
EOF
    echo "STATUS: PASS cpu.dhrystone_l5_l6 (${runner}) - target transcript ingested"
    echo "  result: ${RESULT_JSON}"
    return 0
}

capture_target_transcript() {
    target_cmd=${E1_DHRYSTONE_TARGET_CMD:-}
    if [ -z "${target_cmd}" ]; then
        return 1
    fi
    capture_path="${RESULTS_DIR}/target-command-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
    if ! sh -c "${target_cmd}" > "${capture_path}" 2>&1; then
        target_cmd_json=$(printf '%s' "${target_cmd}" | json_quote)
        capture_path_json=$(printf '%s' "${capture_path}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": $(printf '%s' "${DUT}" | json_quote),
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_DHRYSTONE_TARGET_CMD failed before a promotable Dhrystone target transcript was captured",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_TARGET_CMD='<target command>' E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "target_command": ${target_cmd_json},
  "artifacts": {
    "raw_output": ${capture_path_json}
  },
  "blocked_requirements": [
    {"name": "target.runner.dhrystone", "reason": "target command exited non-zero", "resolution": "Fix the target-side Dhrystone command and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "captured output is a failed target session, not promotable benchmark evidence", "resolution": "Provide a successful Dhrystone target transcript."}
  ],
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.dhrystone_l5_l6 (${DUT}) - target command failed"
        echo "  result: ${RESULT_JSON}"
        return 0
    fi
    E1_DHRYSTONE_RAW_OUTPUT="${capture_path}"
    export E1_DHRYSTONE_RAW_OUTPUT
    write_passed_from_transcript
}

case "${DUT}" in
    prototype|silicon|phone)
        ;;
    *)
        dut_json=$(printf '%s' "${DUT}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "unsupported E1_DHRYSTONE_DUT selector for L5/L6 phone evidence; use prototype, silicon, or phone",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "blocked_requirements": [
    {"name": "target.selector", "reason": "unsupported E1_DHRYSTONE_DUT selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.runner.dhrystone", "reason": "missing target-side runner/transcript capture", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.dut", "reason": "requires L5/L6 phone or prototype silicon DUT", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw Dhrystone target output must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "requires calibrated CPU clock source for DMIPS/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty measured Dhrystone metrics from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.dhrystone_l5_l6 - unsupported E1_DHRYSTONE_DUT=${DUT}"
        exit 0
        ;;
esac

if write_passed_from_transcript; then
    exit 0
fi

if capture_target_transcript; then
    exit 0
fi

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": $(printf '%s' "${DUT}" | json_quote),
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "Dhrystone L5/L6 target transcript was not provided; requires E1_DHRYSTONE_RAW_OUTPUT or E1_DHRYSTONE_TARGET_CMD plus target metadata, calibrated clocks/power/thermal context, raw output hash, and L5/L6 result metadata",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "result_artifact": "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
  "next_command": "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> E1_DHRYSTONE_TARGET_CMD='<target command>' E1_DHRYSTONE_TARGET_METADATA=<metadata.json> E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> make dhrystone-l5-l6",
  "blocked_requirements": [
    {"name": "target.runner.dhrystone", "reason": "missing target-side runner/transcript capture", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "set E1_DHRYSTONE_RAW_OUTPUT to an archived Dhrystone target transcript", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.metadata", "reason": "set E1_DHRYSTONE_TARGET_METADATA to real target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.dut", "reason": "requires L5/L6 phone or prototype silicon DUT", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw Dhrystone target output must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "requires calibrated CPU clock source for DMIPS/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.power_thermal", "reason": "requires power and thermal metadata for phone/prototype claim context", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty measured Dhrystone metrics from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF

echo "STATUS: BLOCKED cpu.dhrystone_l5_l6 (${DUT}) - target transcript not provided"
echo "  result: ${RESULT_JSON}"
