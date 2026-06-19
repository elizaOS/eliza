#!/bin/sh
# run_jetstream.sh — JetStream 2 harness for the e1 CPU AP.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/jetstream"
RESULT_JSON="${RESULTS_DIR}/result.json"
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

write_blocked() {
    reason=$1
    reason_json=$(printf '%s' "${reason}" | json_quote)
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "reason": ${reason_json},
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "blocked_requirements": [
    {"name": "riscv64_js_engine", "reason": "requires executable V8 d8/v8_shell or Hermes RISC-V build", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "jetstream2_sources", "reason": "requires pinned JetStream 2.2 workload bundle or browserbench-compatible harness", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.runner.jetstream2", "reason": "requires DUT where JS engine and benchmark harness coexist at usable speed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.metadata", "reason": "requires clocks, power, thermal, process, software, and calibration metadata", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw JetStream output must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty JetStream 2 score metrics from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.jetstream2 - ${reason}"
    exit 0
}

write_passed_from_transcript() {
    raw_output=${E1_JETSTREAM_RAW_OUTPUT:-}
    runner=${E1_JETSTREAM_TARGET_RUNNER:-${E1_JETSTREAM_DUT:-}}
    metadata=${E1_JETSTREAM_TARGET_METADATA:-}

    if [ -z "${raw_output}" ] || [ ! -f "${raw_output}" ]; then
        return 1
    fi
    raw_output_json=$(printf '%s' "${raw_output}" | json_quote)
    if ! path_under_root "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_JETSTREAM_RAW_OUTPUT must be an archived artifact under packages/chip before a JetStream L5/L6 transcript can be promoted",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "artifacts": {
    "raw_output": ${raw_output_json}
  },
  "blocked_requirements": [
    {"name": "artifacts.raw_output", "reason": "raw target output must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target transcript not archived"
        return 0
    fi

    case "${runner}" in
        prototype|silicon|phone)
            ;;
        *)
            cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_JETSTREAM_TARGET_RUNNER must identify prototype, silicon, or phone before a JetStream L5/L6 transcript can be promoted",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "blocked_requirements": [
    {"name": "target.runner.jetstream2", "reason": "invalid target runner selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target_execution.runner", "reason": "must be prototype, silicon, or phone", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
            echo "STATUS: BLOCKED cpu.jetstream2 - invalid E1_JETSTREAM_TARGET_RUNNER"
            return 0
            ;;
    esac

    if [ -z "${metadata}" ] || [ ! -f "${metadata}" ]; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_JETSTREAM_TARGET_METADATA must point at real target metadata before a JetStream L5/L6 transcript can be promoted",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "blocked_requirements": [
    {"name": "target.metadata", "reason": "missing target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.clock_source", "reason": "metadata must include calibrated clock evidence for JetStream score context", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "calibration.power_thermal", "reason": "metadata must include power and thermal context", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target metadata missing"
        return 0
    fi
    metadata_json=$(printf '%s' "${metadata}" | json_quote)
    if ! path_under_root "${metadata}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "E1_JETSTREAM_TARGET_METADATA must be an archived artifact under packages/chip before a JetStream L5/L6 transcript can be promoted",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "target_metadata": ${metadata_json}
  },
  "blocked_requirements": [
    {"name": "artifacts.target_metadata", "reason": "target metadata must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target metadata not archived"
        return 0
    fi

    raw_sha=$(sha256sum "${raw_output}" | awk '{print $1}')
    metadata_sha=$(sha256sum "${metadata}" | awk '{print $1}')
    runner_json=$(printf '%s' "${runner}" | json_quote)
    metadata_errors=$(python3 "${ROOT}/scripts/target_metadata_contract.py" "${metadata}" --runner "${runner}" --artifact-root "${ROOT}" --required-calibration-asset jetstream_engine 2>&1) || {
        metadata_errors_json=$(printf '%s' "${metadata_errors}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "JetStream target metadata does not satisfy the L5/L6 metadata contract",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
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
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target metadata contract failed"
        return 0
    }
    score=$(awk '
        BEGIN { IGNORECASE = 1 }
        /JetStream[[:space:]]*2/ && /Score/ {
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^[0-9]+([.][0-9]+)?$/) {
                    value = $i
                }
            }
        }
        END { if (value != "") print value }
    ' "${raw_output}")

    if ! grep -qi 'BrowserBench JetStream 2.2' "${raw_output}" || ! grep -qi 'JetStream[[:space:]]*2.*Score' "${raw_output}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "JetStream target transcript is present but lacks required BrowserBench JetStream 2.2 markers",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "transcript.jetstream_markers", "reason": "requires BrowserBench JetStream 2.2 and JetStream 2 Score markers from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target transcript markers missing"
        return 0
    fi

    if [ -z "${score}" ] || ! is_positive_number "${score}"; then
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "claim_level": "L5_PROTOTYPE_SILICON",
  "reason": "JetStream target transcript is present but does not contain a parseable JetStream 2 score",
  "next_command": "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "artifacts": {
    "raw_output": ${raw_output_json},
    "raw_output_sha256": "${raw_sha}",
    "target_metadata": ${metadata_json},
    "target_metadata_sha256": "${metadata_sha}"
  },
  "blocked_requirements": [
    {"name": "metrics", "reason": "requires parseable JetStream 2 score from target output", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
  "metrics": {}
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target transcript score not parseable"
        return 0
    fi

    if ! is_sha256 "${raw_sha}" || ! is_sha256 "${metadata_sha}"; then
        echo "STATUS: FAIL cpu.jetstream2 - internal sha256 calculation failed" >&2
        exit 1
    fi

    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "passed",
  "provenance": "target-measured",
  "claim_level": "L5_PROTOTYPE_SILICON",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json",
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
    "jetstream2_score": ${score}
  }
}
EOF
    echo "STATUS: PASS cpu.jetstream2 (${runner}) - target transcript ingested"
    echo "  result: ${RESULT_JSON}"
    return 0
}

capture_target_transcript() {
    target_cmd=${E1_JETSTREAM_TARGET_CMD:-}
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
  "benchmark": "jetstream2",
  "status": "blocked",
  "provenance": "blocked_missing_target_evidence",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "reason": "E1_JETSTREAM_TARGET_CMD failed before a promotable JetStream target transcript was captured",
  "next_command": "E1_JETSTREAM_TARGET_CMD='<target command>' E1_JETSTREAM_TARGET_METADATA=<metadata.json> E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> make jetstream",
  "target_command": ${target_cmd_json},
  "artifacts": {
    "raw_output": ${capture_path_json}
  },
  "blocked_requirements": [
    {"name": "target.runner.jetstream2", "reason": "target command exited non-zero", "resolution": "Fix the target-side JetStream command and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "captured output is a failed target session, not promotable benchmark evidence", "resolution": "Provide a successful JetStream target transcript."}
  ],
  "metrics": {},
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json"
}
EOF
        echo "STATUS: BLOCKED cpu.jetstream2 - target command failed"
        echo "  result: ${RESULT_JSON}"
        return 0
    fi
    E1_JETSTREAM_RAW_OUTPUT="${capture_path}"
    export E1_JETSTREAM_RAW_OUTPUT
    write_passed_from_transcript
}

if write_passed_from_transcript; then
    exit 0
fi

if capture_target_transcript; then
    exit 0
fi

find_engine() {
    if [ -n "${E1_JETSTREAM_ENGINE_BIN:-}" ]; then
        [ -x "${E1_JETSTREAM_ENGINE_BIN}" ] && return 0
        write_blocked "E1_JETSTREAM_ENGINE_BIN is set but not executable: ${E1_JETSTREAM_ENGINE_BIN}"
    fi
    for candidate in \
        "${ROOT}/external/v8-riscv64/d8" \
        "${ROOT}/external/v8-riscv64/out/riscv64.release/d8" \
        "${ROOT}/external/v8-riscv64/out/riscv64.release/v8_shell" \
        "${ROOT}/external/hermes-riscv64/hermes" \
        "${ROOT}/external/hermes-riscv64/build/bin/hermes"; do
        [ -x "${candidate}" ] && return 0
    done
    return 1
}

if ! find_engine; then
    write_blocked "no executable JS engine RISC-V build available (set E1_JETSTREAM_ENGINE_BIN, or provide v8-riscv64 d8/v8_shell or hermes-riscv64 hermes)"
fi

DUT="${E1_JETSTREAM_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked "E1_JETSTREAM_DUT not set; choose prototype|silicon|phone for L5/L6 phone evidence"
fi

write_blocked "DUT=${DUT} target command not provided; set E1_JETSTREAM_TARGET_CMD to capture a JetStream transcript from a target where the JS engine and benchmark harness coexist at usable speed"
