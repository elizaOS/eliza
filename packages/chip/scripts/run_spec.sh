#!/bin/sh
# run_spec.sh — fail-closed SPEC CPU 2017 harness for the e1 CPU AP.
#
# SPEC CPU 2017 is paid commercial software; the repo never holds SPEC
# sources, binaries, or license keys. This harness reads SPEC artifacts
# from $SPEC_DIR at runtime, never copies them into the repo, and only
# writes numeric scores plus configuration metadata to the result file.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/spec"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

now() { date -u +%FT%TZ; }

json_quote() {
    python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
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
  "benchmark": "spec-cpu-2017",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "reason": ${reason_json},
  "next_command": "E1_SPEC_RAW_OUTPUT=<target-runcpu-report> E1_SPEC_TARGET_CMD='<target command>' E1_SPEC_TARGET_METADATA=<metadata.json> E1_SPEC_TARGET_RUNNER=<prototype|silicon|phone> E1_SPEC_RUN_MANIFEST=<run-manifest.json> SPEC_LICENSE_SHA256=<sha256> make spec-skeleton",
  "blocked_requirements": [
    {"name": "licensed_spec_cpu2017_install", "reason": "SPEC_DIR must point at licensed SPEC CPU 2017 v1.1.9 install for local execution, or E1_SPEC_RAW_OUTPUT must point at an archived target runcpu report", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "license_hash", "reason": "SPEC_LICENSE_SHA256 or E1_SPEC_LICENSE_SHA256 must record the licensed-run hash without copying license material into the repo", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.runner.spec_cpu2017", "reason": "requires prototype/silicon/phone target runner capable of meaningful SPEC sample sizes", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "target.metadata", "reason": "requires clocks, memory, power, thermal, process, software, and calibration metadata", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "artifacts.raw_output_sha256", "reason": "raw SPEC output/report bundle must be archived and hashed", "resolution": "Provide the required evidence and rerun the benchmark harness."},
    {"name": "metrics", "reason": "requires non-empty SPEC score metrics parsed from runcpu outputs", "resolution": "Provide the required evidence and rerun the benchmark harness."}
  ],
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/spec/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.spec_cpu_2017 - ${reason}"
    exit 0
}

write_transcript_result() {
    [ -n "${E1_SPEC_RAW_OUTPUT:-}" ] || return 1
    export ROOT RESULT_JSON
    python3 - <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["ROOT"])
sys.path.insert(0, str(root / "scripts"))
from target_metadata_contract import validate_target_metadata  # noqa: E402

result_json = Path(os.environ["RESULT_JSON"])
raw_output = os.environ.get("E1_SPEC_RAW_OUTPUT", "")
metadata = os.environ.get("E1_SPEC_TARGET_METADATA", "")
runner = os.environ.get("E1_SPEC_TARGET_RUNNER") or os.environ.get("E1_SPEC_DUT", "")
license_sha = os.environ.get("E1_SPEC_LICENSE_SHA256") or os.environ.get("SPEC_LICENSE_SHA256", "")
run_manifest = os.environ.get("E1_SPEC_RUN_MANIFEST", "")

next_command = (
    "E1_SPEC_RAW_OUTPUT=<target-runcpu-report> "
    "E1_SPEC_TARGET_METADATA=<metadata.json> "
    "E1_SPEC_TARGET_RUNNER=<prototype|silicon|phone> "
    "E1_SPEC_RUN_MANIFEST=<run-manifest.json> "
    "SPEC_LICENSE_SHA256=<sha256> make spec-skeleton"
)
allowed_runners = {"prototype", "silicon", "phone"}
required_metrics = {
    "specint2017_rate_base": [
        r"\bSPECint2017[_\s-]*rate[_\s-]*base\b",
        r"\bintrate[_\s-]*base\b",
        r"\bint[_\s-]*rate[_\s-]*base\b",
    ],
    "specint2017_speed_base": [
        r"\bSPECint2017[_\s-]*speed[_\s-]*base\b",
        r"\bintspeed[_\s-]*base\b",
        r"\bint[_\s-]*speed[_\s-]*base\b",
    ],
    "specfp2017_rate_base": [
        r"\bSPECfp2017[_\s-]*rate[_\s-]*base\b",
        r"\bfprate[_\s-]*base\b",
        r"\bfp[_\s-]*rate[_\s-]*base\b",
    ],
    "specfp2017_speed_base": [
        r"\bSPECfp2017[_\s-]*speed[_\s-]*base\b",
        r"\bfpspeed[_\s-]*base\b",
        r"\bfp[_\s-]*speed[_\s-]*base\b",
    ],
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_under_root(path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write(payload: dict) -> None:
    result_json.parent.mkdir(parents=True, exist_ok=True)
    result_json.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def blocked(reason: str, requirements: list[dict], artifacts: dict | None = None) -> None:
    payload = {
        "schema": "eliza.cpu_benchmark_result.v1",
        "benchmark": "spec-cpu-2017",
        "status": "blocked",
        "provenance": "blocked_placeholder",
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "claim_level": "L5_PROTOTYPE_SILICON",
        "reason": reason,
        "next_command": next_command,
        "blocked_requirements": requirements,
        "result_recorded_at": now(),
        "manifest": "benchmarks/cpu/spec/manifest.json",
        "metrics": {},
    }
    if artifacts:
        payload["artifacts"] = artifacts
    write(payload)
    print(f"STATUS: BLOCKED cpu.spec_cpu_2017 - {reason}")


def parse_metrics(text: str) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for key, labels in required_metrics.items():
        for line in text.splitlines():
            normalized = line.strip()
            if not normalized:
                continue
            if not any(re.search(label, normalized, re.IGNORECASE) for label in labels):
                continue
            match = re.search(r"[:=]\s*([0-9]+(?:\.[0-9]+)?)\b", normalized)
            if not match:
                numbers = re.findall(r"\b[0-9]+(?:\.[0-9]+)?\b", normalized)
                match_value = numbers[-1] if numbers else None
            else:
                match_value = match.group(1)
            if match_value is not None:
                metrics[key] = float(match_value)
                break
    return metrics


raw_path = Path(raw_output)
metadata_path = Path(metadata) if metadata else None
artifacts: dict[str, str] = {}

if not raw_path.is_file():
    blocked(
        f"E1_SPEC_RAW_OUTPUT is set but does not point at a file: {raw_output}",
        [{"name": "artifacts.raw_output_sha256", "reason": "raw target runcpu report/transcript must exist before promotion", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
    )
    sys.exit(0)
if not is_under_root(raw_path):
    blocked(
        "E1_SPEC_RAW_OUTPUT must be an archived artifact under packages/chip before a SPEC transcript can be promoted",
        [{"name": "artifacts.raw_output", "reason": "raw target output must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
    )
    sys.exit(0)

raw_sha = sha256_file(raw_path)
artifacts.update({"raw_output": raw_output, "raw_output_sha256": raw_sha})

if runner not in allowed_runners:
    blocked(
        "E1_SPEC_TARGET_RUNNER must identify prototype, silicon, or phone before a SPEC transcript can be promoted",
        [
            {"name": "target.runner.spec_cpu2017", "reason": "invalid target runner selector", "resolution": "Provide the required evidence and rerun the benchmark harness."},
            {"name": "target_execution.runner", "reason": "must be prototype, silicon, or phone", "resolution": "Provide the required evidence and rerun the benchmark harness."},
        ],
        artifacts,
    )
    sys.exit(0)

if metadata_path is None or not metadata_path.is_file():
    blocked(
        "E1_SPEC_TARGET_METADATA must point at real target metadata before a SPEC L5/L6 transcript can be promoted",
        [
            {"name": "target.metadata", "reason": "missing target metadata JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."},
            {"name": "calibration.clock_source", "reason": "metadata must include calibrated clock evidence for SPEC score context", "resolution": "Provide the required evidence and rerun the benchmark harness."},
            {"name": "calibration.power_thermal", "reason": "metadata must include power and thermal context", "resolution": "Provide the required evidence and rerun the benchmark harness."},
        ],
        artifacts,
    )
    sys.exit(0)
if not is_under_root(metadata_path):
    blocked(
        "E1_SPEC_TARGET_METADATA must be an archived artifact under packages/chip before a SPEC transcript can be promoted",
        [{"name": "artifacts.target_metadata", "reason": "target metadata must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)

metadata_sha = sha256_file(metadata_path)
artifacts.update({"target_metadata": metadata, "target_metadata_sha256": metadata_sha})
try:
    metadata_json = json.loads(metadata_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    blocked(
        f"SPEC target metadata is not valid JSON: {exc}",
        [{"name": "target.metadata.contract", "reason": "metadata must be valid JSON with L5/L6 target context", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)

metadata_errors = validate_target_metadata(metadata_json, runner=runner, artifact_root=root)
if metadata_errors:
    blocked(
        "SPEC target metadata does not satisfy the L5/L6 metadata contract",
        [
            {"name": "target.metadata.contract", "reason": "; ".join(metadata_errors), "resolution": "Provide target metadata that satisfies the L5/L6 contract and rerun the benchmark harness."},
            {"name": "calibration.clock_source", "reason": "requires calibrated clock-source asset with sha256 and evidence", "resolution": "Provide the required evidence and rerun the benchmark harness."},
            {"name": "calibration.power_meter", "reason": "requires calibrated power-meter asset with sha256 and evidence", "resolution": "Provide the required evidence and rerun the benchmark harness."},
            {"name": "target.metadata.sections", "reason": "requires software, clocks, memory, power, thermal, process, and calibration sections", "resolution": "Provide the required evidence and rerun the benchmark harness."},
        ],
        artifacts,
    )
    sys.exit(0)

if not re.fullmatch(r"[0-9a-fA-F]{64}", license_sha) or len(set(license_sha.lower())) == 1:
    blocked(
        "SPEC_LICENSE_SHA256 or E1_SPEC_LICENSE_SHA256 must be a non-placeholder 64-hex hash for the licensed SPEC run",
        [{"name": "license_hash", "reason": "record an out-of-band license/run entitlement hash without copying license material into the repo", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)

artifacts["spec_license_sha256"] = license_sha.lower()
manifest_path = Path(run_manifest) if run_manifest else None
if manifest_path is None or not manifest_path.is_file():
    blocked(
        "E1_SPEC_RUN_MANIFEST must point at an archived SPEC CPU 2017 run manifest before transcript promotion",
        [
            {
                "name": "artifacts.spec_run_manifest",
                "reason": "manifest must bind SPEC version, runcpu command, config, reportable status, and result bundle hash",
                "resolution": "Provide a reportable SPEC run manifest and rerun the benchmark harness.",
            }
        ],
        artifacts,
    )
    sys.exit(0)
if not is_under_root(manifest_path):
    blocked(
        "E1_SPEC_RUN_MANIFEST must be an archived artifact under packages/chip before a SPEC transcript can be promoted",
        [{"name": "artifacts.spec_run_manifest", "reason": "SPEC run manifest must be archived under packages/chip", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)
manifest_sha = sha256_file(manifest_path)
artifacts["spec_run_manifest"] = run_manifest
artifacts["spec_run_manifest_sha256"] = manifest_sha
try:
    manifest_json = json.loads(manifest_path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    blocked(
        f"SPEC run manifest is not valid JSON: {exc}",
        [{"name": "artifacts.spec_run_manifest", "reason": "manifest must be valid JSON", "resolution": "Provide the required evidence and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)
manifest_errors: list[str] = []
for field in ("spec_version", "runcpu_command", "config", "result_bundle"):
    if not isinstance(manifest_json.get(field), str) or not manifest_json[field].strip():
        manifest_errors.append(f"missing {field}")
if "cpu2017" not in str(manifest_json.get("spec_version", "")).lower():
    manifest_errors.append("spec_version must identify SPEC CPU2017")
if "runcpu" not in str(manifest_json.get("runcpu_command", "")).lower():
    manifest_errors.append("runcpu_command must include runcpu")
if manifest_json.get("reportable") is not True:
    manifest_errors.append("reportable must be true")
if not re.fullmatch(r"[0-9a-fA-F]{64}", str(manifest_json.get("config_sha256", ""))) or len(set(str(manifest_json.get("config_sha256", "")).lower())) == 1:
    manifest_errors.append("config_sha256 must be non-placeholder sha256")
config_path = Path(str(manifest_json.get("config", "")))
if not config_path.is_absolute():
    config_path = ROOT / config_path
if not is_under_root(config_path):
    manifest_errors.append("config must be archived under packages/chip")
elif not config_path.is_file():
    manifest_errors.append("config file is missing")
elif re.fullmatch(r"[0-9a-fA-F]{64}", str(manifest_json.get("config_sha256", ""))) and sha256_file(config_path).lower() != str(manifest_json.get("config_sha256", "")).lower():
    manifest_errors.append("config file must match config_sha256")
if not re.fullmatch(r"[0-9a-fA-F]{64}", str(manifest_json.get("result_bundle_sha256", ""))) or len(set(str(manifest_json.get("result_bundle_sha256", "")).lower())) == 1:
    manifest_errors.append("result_bundle_sha256 must be non-placeholder sha256")
elif str(manifest_json.get("result_bundle_sha256", "")).lower() != sha256_file(raw_path).lower():
    manifest_errors.append("result_bundle_sha256 must match raw transcript sha256")
bundle_path = Path(str(manifest_json.get("result_bundle", "")))
if not bundle_path.is_absolute():
    bundle_path = ROOT / bundle_path
if not is_under_root(bundle_path):
    manifest_errors.append("result_bundle must be archived under packages/chip")
elif not bundle_path.is_file():
    manifest_errors.append("result_bundle file is missing")
elif sha256_file(bundle_path).lower() != sha256_file(raw_path).lower():
    manifest_errors.append("result_bundle file must match raw transcript sha256")
if manifest_errors:
    blocked(
        "SPEC run manifest does not satisfy the L5/L6 SPEC provenance contract",
        [{"name": "artifacts.spec_run_manifest", "reason": "; ".join(manifest_errors), "resolution": "Provide a reportable SPEC run manifest and rerun the benchmark harness."}],
        artifacts,
    )
    sys.exit(0)

text = raw_path.read_text(encoding="utf-8", errors="replace")
marker_text = text.lower()
required_markers = {
    "spec_cpu2017": "spec cpu2017" in marker_text or "spec cpu 2017" in marker_text,
    "runcpu": "runcpu" in marker_text,
    "reportable": "reportable" in marker_text,
    "base": "base" in marker_text,
}
missing_markers = [name for name, present in required_markers.items() if not present]
if missing_markers:
    blocked(
        "SPEC target transcript is present but lacks required SPEC CPU 2017 runcpu/reportable markers",
        [
            {
                "name": "transcript.spec_markers",
                "reason": "requires SPEC CPU2017, runcpu, reportable, and base-run markers from the archived target report",
                "resolution": "Provide a complete SPEC runcpu report transcript and rerun the benchmark harness.",
            },
            {"name": "transcript.spec_markers.missing", "reason": ", ".join(missing_markers), "resolution": "Provide a complete SPEC runcpu report transcript and rerun the benchmark harness."},
        ],
        artifacts,
    )
    sys.exit(0)

metrics = parse_metrics(text)
missing = [key for key in required_metrics if key not in metrics]
if missing:
    blocked(
        "SPEC target transcript is present but does not contain all required SPEC CPU 2017 aggregate base scores",
        [
            {
                "name": "metrics",
                "reason": "requires parseable SPECint2017_rate_base, SPECint2017_speed_base, SPECfp2017_rate_base, and SPECfp2017_speed_base",
                "resolution": "Provide SPEC output with all required score metrics and rerun the benchmark harness.",
            },
            {"name": "metrics.missing", "reason": ", ".join(missing), "resolution": "Provide SPEC output with all required score metrics and rerun the benchmark harness."},
        ],
        artifacts,
    )
    sys.exit(0)

write(
    {
        "schema": "eliza.cpu_benchmark_result.v1",
        "benchmark": "spec-cpu-2017",
        "status": "passed",
        "provenance": "target-measured",
        "claim_level": "L5_PROTOTYPE_SILICON",
        "result_recorded_at": now(),
        "manifest": "benchmarks/cpu/spec/manifest.json",
        "artifacts": artifacts,
        "target_execution": {
            "runner": runner,
            "transcript_sha256": raw_sha,
        },
        "metrics": metrics,
    }
)
print(f"STATUS: PASS cpu.spec_cpu_2017 ({runner}) - target transcript ingested")
print(f"  result: {result_json}")
PY
    return 0
}

capture_target_transcript() {
    target_cmd=${E1_SPEC_TARGET_CMD:-}
    if [ -z "${target_cmd}" ]; then
        return 1
    fi
    capture_path=${E1_SPEC_TARGET_CAPTURE_OUTPUT:-}
    if [ -z "${capture_path}" ]; then
        capture_path="${RESULTS_DIR}/target-command-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
    fi
    if ! path_under_root "${capture_path}"; then
        write_blocked "E1_SPEC_TARGET_CAPTURE_OUTPUT must be an archived artifact path under packages/chip"
    fi
    mkdir -p "$(dirname "${capture_path}")"
    if ! sh -c "${target_cmd}" > "${capture_path}" 2>&1; then
        target_cmd_json=$(printf '%s' "${target_cmd}" | json_quote)
        capture_path_json=$(printf '%s' "${capture_path}" | json_quote)
        cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "spec-cpu-2017",
  "status": "blocked",
  "provenance": "blocked_placeholder",
  "claim_allowed": false,
  "phone_claim_allowed": false,
  "release_claim_allowed": false,
  "reason": "E1_SPEC_TARGET_CMD failed before a promotable SPEC CPU2017 target transcript was captured",
  "next_command": "E1_SPEC_TARGET_CMD='<target command>' E1_SPEC_TARGET_METADATA=<metadata.json> E1_SPEC_TARGET_RUNNER=<prototype|silicon|phone> E1_SPEC_RUN_MANIFEST=<run-manifest.json> SPEC_LICENSE_SHA256=<sha256> make spec-skeleton",
  "target_command": ${target_cmd_json},
  "artifacts": {
    "raw_output": ${capture_path_json}
  },
  "blocked_requirements": [
    {"name": "target.runner.spec_cpu2017", "reason": "target command exited non-zero", "resolution": "Fix the target-side SPEC command and rerun the benchmark harness."},
    {"name": "target.raw_output", "reason": "captured output is a failed target session, not promotable benchmark evidence", "resolution": "Provide a successful SPEC runcpu report transcript."}
  ],
  "metrics": {},
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/spec/manifest.json"
}
EOF
        echo "STATUS: BLOCKED cpu.spec_cpu_2017 - target command failed"
        echo "  result: ${RESULT_JSON}"
        return 0
    fi
    E1_SPEC_RAW_OUTPUT="${capture_path}"
    export E1_SPEC_RAW_OUTPUT
    write_transcript_result
}

if write_transcript_result; then
    exit 0
fi

if capture_target_transcript; then
    exit 0
fi

if [ -z "${SPEC_DIR:-}" ]; then
    write_blocked "SPEC_DIR not set; SPEC CPU 2017 requires a licensed install"
fi

if [ ! -x "${SPEC_DIR}/bin/runcpu" ]; then
    write_blocked "no runcpu at ${SPEC_DIR}/bin/runcpu; license install incomplete"
fi

if [ ! -f "${SPEC_DIR}/version.txt" ]; then
    write_blocked "no version.txt at ${SPEC_DIR}; cannot verify pinned SPEC version"
fi

if ! grep -q "1.1.9" "${SPEC_DIR}/version.txt"; then
    write_blocked "SPEC version at ${SPEC_DIR}/version.txt does not match pinned SPEC CPU 2017 1.1.9"
fi

if [ -z "${SPEC_LICENSE_SHA256:-}" ]; then
    write_blocked "SPEC_LICENSE_SHA256 not set; license hash must be recorded out-of-band before running SPEC"
fi

if [ -z "${SPEC_LICENSE_FILE:-}" ]; then
    write_blocked "SPEC_LICENSE_FILE not set; cannot verify SPEC_LICENSE_SHA256"
fi

if [ ! -f "${SPEC_LICENSE_FILE}" ]; then
    write_blocked "SPEC_LICENSE_FILE does not exist at ${SPEC_LICENSE_FILE}"
fi

actual_license_sha=$(sha256sum "${SPEC_LICENSE_FILE}" | awk '{print $1}')
if [ "${actual_license_sha}" != "${SPEC_LICENSE_SHA256}" ]; then
    write_blocked "SPEC_LICENSE_SHA256 does not match SPEC_LICENSE_FILE"
fi

if [ -z "${E1_SPEC_DUT:-}" ]; then
    write_blocked "E1_SPEC_DUT not set; choose prototype|silicon|phone for L5/L6 phone evidence"
fi

LLVM_CLANG="${ROOT}/build/llvm-stage2/bin/clang"
if [ ! -x "${LLVM_CLANG}" ]; then
    write_blocked "pinned LLVM RISC-V clang absent at ${LLVM_CLANG}; run scripts/build_llvm_riscv.sh inside the canonical Linux container"
fi

write_blocked "SPEC harness is structurally complete but no target runner is implemented yet for E1_SPEC_DUT=${E1_SPEC_DUT}; remaining blockers are licensed SPEC workload execution plus a prototype, silicon, or phone DUT capable of meaningful SPEC sample sizes"
