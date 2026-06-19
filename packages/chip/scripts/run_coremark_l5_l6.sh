#!/bin/sh
# Fail-closed phone/prototype CoreMark L5/L6 harness.
#
# This writes a separate L5/L6 artifact from the local CVA6 Verilator result
# so phone-class claim gates cannot accidentally consume simulator evidence.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/coremark"
RESULT_JSON="${RESULTS_DIR}/l5_l6_result.json"
DUT="${E1_COREMARK_DUT:-prototype}"
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
    raw_output=${E1_COREMARK_RAW_OUTPUT:-}
    runner=${E1_COREMARK_TARGET_RUNNER:-${DUT}}
    metadata=${E1_COREMARK_TARGET_METADATA:-}
    dut_json=$(printf '%s' "${DUT}" | json_quote)

    if [ -z "${raw_output}" ] || [ ! -f "${raw_output}" ]; then
        return 1
    fi
    raw_output_json=$(printf '%s' "${raw_output}" | json_quote)
    if ! path_under_root "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_COREMARK_RAW_OUTPUT must be an archived artifact under packages/chip before a CoreMark L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_COREMARK_TARGET_RUNNER must identify prototype, silicon, or phone before a CoreMark L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "blocked_requirements": [
    {"name": "target.runner.coremark", "reason": "invalid target runner selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_COREMARK_TARGET_METADATA must point at real target metadata before a CoreMark L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "blocked_requirements": [
    {"name": "target.metadata", "reason": "missing target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "metadata must include calibrated clock evidence for CoreMark/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."}
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_COREMARK_TARGET_METADATA must be an archived artifact under packages/chip before a CoreMark L5/L6 transcript can be promoted",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
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
    metadata_errors=$(python3 "${ROOT}/scripts/target_metadata_contract.py" "${metadata}" --runner "${runner}" --artifact-root "${ROOT}" --required-calibration-asset coremark_binary 2>&1) || {
        metadata_errors_json=$(printf '%s' "${metadata_errors}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "CoreMark target metadata does not satisfy the L5/L6 metadata contract",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
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
    iterations=$(awk -F: 'tolower($1) ~ /iterations\/sec/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "${raw_output}")
    per_mhz=$(awk -F: 'tolower($1) ~ /coremark\/mhz/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "${raw_output}")

    if ! grep -qi 'CoreMark Size' "${raw_output}" || ! grep -qi 'Correct operation validated' "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "CoreMark target transcript is present but lacks required CoreMark run/correctness markers",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "transcript.coremark_markers", "reason": "requires CoreMark Size and Correct operation validated markers from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    if [ -z "${iterations}" ] || [ -z "${per_mhz}" ] || ! is_positive_number "${iterations}" || ! is_positive_number "${per_mhz}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "CoreMark target transcript is present but does not contain parseable Iterations/Sec and CoreMark/MHz lines",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "metrics", "reason": "requires parseable Iterations/Sec and CoreMark/MHz from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        return 0
    fi

    if ! is_sha256 "${raw_sha}" || ! is_sha256 "${metadata_sha}"; then
        echo "STATUS: FAIL cpu.coremark_l5_l6 - internal sha256 calculation failed" >&2
        exit 1
    fi

    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "passed",
  "provenance": "target-measured",
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
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
    "iterations_per_second": ${iterations},
    "coremark_per_mhz": ${per_mhz}
  }
}
EOF
    echo "STATUS: PASS cpu.coremark_l5_l6 (${runner}) - target transcript ingested"
    echo "  result: ${RESULT_JSON}"
    return 0
}

capture_target_transcript() {
    target_cmd=${E1_COREMARK_TARGET_CMD:-}
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": $(printf '%s' "${DUT}" | json_quote),
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_COREMARK_TARGET_CMD failed before a promotable CoreMark target transcript was captured",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_TARGET_CMD='<target command>' E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "target_command": ${target_cmd_json},
  "artifacts": {
    "raw_output": ${capture_path_json}
  },
  "blocked_requirements": [
    {"name": "target.runner.coremark", "reason": "target command exited non-zero", "resolution": "Fix the target-side CoreMark command and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "captured output is a failed target session, not promotable benchmark evidence", "resolution": "Provide a successful CoreMark target transcript."}
  ],
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.coremark_l5_l6 (${DUT}) - target command failed"
        echo "  result: ${RESULT_JSON}"
        return 0
    fi
    E1_COREMARK_RAW_OUTPUT="${capture_path}"
    export E1_COREMARK_RAW_OUTPUT
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": ${dut_json},
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "unsupported E1_COREMARK_DUT selector for L5/L6 phone evidence; use prototype, silicon, or phone",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "blocked_requirements": [
    {"name": "target.selector", "reason": "unsupported E1_COREMARK_DUT selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.runner.coremark", "reason": "missing target-side runner/transcript capture", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.dut", "reason": "requires L5/L6 phone or prototype silicon DUT", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw CoreMark target output must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "requires calibrated CPU clock source for CoreMark/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty measured CoreMark metrics from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.coremark_l5_l6 - unsupported E1_COREMARK_DUT=${DUT}"
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
  "benchmark": "coremark",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "dut": $(printf '%s' "${DUT}" | json_quote),
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "CoreMark L5/L6 target transcript was not provided; requires E1_COREMARK_RAW_OUTPUT or E1_COREMARK_TARGET_CMD plus target metadata, calibrated clocks/power/thermal context, raw output hash, and L5/L6 result metadata",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "result_artifact": "benchmarks/results/cpu/coremark/l5_l6_result.json",
  "next_command": "E1_COREMARK_RAW_OUTPUT=<target-transcript> E1_COREMARK_TARGET_CMD='<target command>' E1_COREMARK_TARGET_METADATA=<metadata.json> E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> make coremark-l5-l6",
  "blocked_requirements": [
    {"name": "target.runner.coremark", "reason": "missing target-side runner/transcript capture", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "set E1_COREMARK_RAW_OUTPUT to an archived CoreMark target transcript", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.metadata", "reason": "set E1_COREMARK_TARGET_METADATA to real target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.dut", "reason": "requires L5/L6 phone or prototype silicon DUT", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw CoreMark target output must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "requires calibrated CPU clock source for CoreMark/MHz", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.power_thermal", "reason": "requires power and thermal metadata for phone/prototype claim context", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty measured CoreMark metrics from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "metrics": {}
}
EOF

echo "STATUS: BLOCKED cpu.coremark_l5_l6 (${DUT}) - target transcript not provided"
echo "  result: ${RESULT_JSON}"
