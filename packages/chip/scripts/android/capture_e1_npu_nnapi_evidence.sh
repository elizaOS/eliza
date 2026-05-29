#!/usr/bin/env bash
# Capture Android NNAPI e1-npu transcripts from a real connected target.

set -euo pipefail

repo_root="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
out_dir="${E1_NPU_NNAPI_EVIDENCE_DIR:-$repo_root/docs/evidence/android/e1-npu}"
model="${E1_NPU_TFLITE_MODEL:-$repo_root/benchmarks/models/mobile_smoke.tflite}"
device_model="${E1_NPU_DEVICE_MODEL:-/data/local/tmp/mobile_smoke.tflite}"
accelerator="${E1_NPU_NNAPI_ACCELERATOR:-e1-npu}"
dma_trace="${E1_NPU_DMA_TRACE:-/sys/bus/platform/devices/10020000.npu/dma_trace}"
proof_json="${E1_NPU_NNAPI_PROOF_JSON:-$repo_root/benchmarks/capabilities/e1_npu_nnapi.proof.json}"
refresh_android_manifest="${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}"

die() {
	printf 'capture_e1_npu_nnapi_evidence: %s\n' "$*" >&2
	exit 2
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "missing on PATH: $1"
}

run_log() {
	name=$1
	out=$2
	command_label=$3
	shift 3
	start_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	status=FAIL
	rc_file="${out}.rc.tmp"
	rm -f "$rc_file"
	set +e
	{
		echo "eliza-evidence: target=android artifact=$name"
		echo "eliza-evidence: claim_boundary=target_transcript_only_not_benchmark_or_compatibility_claim"
		echo "COMMAND=$command_label"
		echo "START_UTC=$start_utc"
		echo "BOOT_CLAIM=none"
		echo "COMPATIBILITY_CLAIM=none"
		"$@"
		command_rc=$?
		end_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		if [ "$command_rc" -eq 0 ]; then
			status=PASS
		fi
		echo "eliza-evidence: ended_utc=$end_utc"
		echo "eliza-evidence: status=$status"
		echo "END_UTC=$end_utc"
		echo "RESULT=$command_rc"
		printf '%s\n' "$command_rc" >"$rc_file"
	} >"$out" 2>&1
	rc="$(cat "$rc_file" 2>/dev/null || printf '1')"
	rm -f "$rc_file"
	set -e
	return "$rc"
}

require_cmd adb
[ -s "$model" ] || die "missing non-empty model: $model"

mkdir -p "$out_dir"
devices="$(adb devices | awk 'NR > 1 && $2 == "device" {print $1}')"
device_count="$(printf '%s\n' "$devices" | grep -c . || true)"
[ "$device_count" = "1" ] || die "expected exactly 1 ready adb device, found $device_count"

run_log adb_devices "$out_dir/adb-devices.log" "adb devices" adb devices
adb push "$model" "$device_model" >/dev/null
run_log nnapi_accelerator_query "$out_dir/nnapi-accelerator-query.log" \
	"adb shell cmd neuralnetworks list" \
	adb shell cmd neuralnetworks list
run_log benchmark_model_nnapi "$out_dir/benchmark-model-nnapi.log" \
	"adb shell benchmark_model --graph=$device_model --use_nnapi=true --nnapi_accelerator_name=$accelerator --enable_op_profiling=true --verbose=true" \
	adb shell benchmark_model "--graph=$device_model" --use_nnapi=true \
	"--nnapi_accelerator_name=$accelerator" --enable_op_profiling=true --verbose=true
run_log dma_trace "$out_dir/dma-trace.log" \
	"adb shell cat $dma_trace" \
	adb shell cat "$dma_trace"

python3 - "$repo_root" "$out_dir" "$model" "$device_model" "$accelerator" "$dma_trace" "$proof_json" <<'PY'
import json
import math
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

root = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
model = Path(sys.argv[3])
device_model = sys.argv[4]
accelerator = sys.argv[5]
dma_trace = sys.argv[6]
proof_json = Path(sys.argv[7])

EXPECTED_DEVICE_MODEL = "/data/local/tmp/mobile_smoke.tflite"
CAPTURE_COMMANDS = {
    "adb_devices": "adb devices",
    "nnapi_accelerator_query": "adb shell cmd neuralnetworks list",
    "benchmark_model_nnapi": (
        "adb shell benchmark_model --graph=/data/local/tmp/mobile_smoke.tflite "
        "--use_nnapi=true --nnapi_accelerator_name=e1-npu "
        "--enable_op_profiling=true --verbose=true"
    ),
    "dma_trace": "adb shell cat /sys/bus/platform/devices/10020000.npu/dma_trace",
}
REQUIRED_MARKERS = {
    "adb_devices": ["device"],
    "nnapi_accelerator_query": ["e1-npu"],
    "benchmark_model_nnapi": [
        "--use_nnapi=true",
        "--nnapi_accelerator_name=e1-npu",
        "NNAPI",
    ],
    "dma_trace": ["e1-npu", "DMA", "bytes_read", "bytes_written"],
}


def rel(path: Path) -> str:
    return str(path.relative_to(root))

def sha(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

logs = {
    "adb_devices": out_dir / "adb-devices.log",
    "nnapi_accelerator_query": out_dir / "nnapi-accelerator-query.log",
    "benchmark_model_nnapi": out_dir / "benchmark-model-nnapi.log",
    "dma_trace": out_dir / "dma-trace.log",
}
transcripts = {
    name: {"path": rel(path), "sha256": sha(path), "bytes": path.stat().st_size}
    for name, path in logs.items()
}
marker_errors = []
for name, markers in REQUIRED_MARKERS.items():
    text = logs[name].read_text(encoding="utf-8", errors="replace")
    for marker in markers:
        if marker not in text:
            marker_errors.append(f"{rel(logs[name])} missing marker {marker!r}")

manifest = {
    "schema": "eliza.e1_npu_nnapi_capture_manifest.v1",
    "status": "blocked" if marker_errors else "captured_transcripts_ready",
    "claim_boundary": "not_a_capability_proof_until_benchmarks/capabilities/e1_npu_nnapi.proof.json_is_reviewed",
    "required_markers": REQUIRED_MARKERS,
    "marker_errors": marker_errors,
    "model_artifacts": {
        "benchmarks/models/mobile_smoke.tflite": {
            "path": rel(model),
            "sha256": sha(model),
            "bytes": model.stat().st_size,
        }
    },
    "transcripts": transcripts,
}

def require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"E1_NPU_WRITE_PROOF_JSON=1 requires {name}")
    return value


def env_int(name: str) -> int:
    value = require_env(name)
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise SystemExit(f"{name} must be positive")
    return parsed


def env_nonnegative_int(name: str) -> int:
    value = require_env(name)
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if parsed < 0:
        raise SystemExit(f"{name} must be non-negative")
    return parsed


def env_float(name: str) -> float:
    value = require_env(name)
    try:
        parsed = float(value)
    except ValueError as exc:
        raise SystemExit(f"{name} must be numeric") from exc
    if not math.isfinite(parsed) or parsed <= 0.0:
        raise SystemExit(f"{name} must be positive")
    return parsed


write_proof_json = os.environ.get("E1_NPU_WRITE_PROOF_JSON") == "1" and not marker_errors
if write_proof_json:
    if device_model != EXPECTED_DEVICE_MODEL:
        raise SystemExit(
            f"E1_NPU_DEVICE_MODEL must be {EXPECTED_DEVICE_MODEL} when writing proof JSON"
        )
    if accelerator != "e1-npu":
        raise SystemExit("E1_NPU_NNAPI_ACCELERATOR must be e1-npu when writing proof JSON")
    if dma_trace != "/sys/bus/platform/devices/10020000.npu/dma_trace":
        raise SystemExit("E1_NPU_DMA_TRACE must use the contract trace path when writing proof JSON")

    macs = env_int("E1_NPU_MACS_PER_INFERENCE")
    cycles = env_int("E1_NPU_CYCLES")
    hz = env_float("E1_NPU_HZ")
    bytes_read = env_int("E1_NPU_DMA_BYTES_READ")
    bytes_written = env_int("E1_NPU_DMA_BYTES_WRITTEN")
    delegated = env_nonnegative_int("E1_NPU_NNAPI_DELEGATED_NODE_COUNT")
    total = env_int("E1_NPU_NNAPI_TOTAL_NODE_COUNT")
    if delegated > total:
        raise SystemExit("E1_NPU_NNAPI_DELEGATED_NODE_COUNT must be <= E1_NPU_NNAPI_TOTAL_NODE_COUNT")
    dataflow_name = require_env("E1_NPU_DATAFLOW_NAME")
    generated_by = require_env("E1_NPU_GENERATED_BY")
    target = require_env("E1_NPU_TARGET")
    precision = os.environ.get("E1_NPU_PRECISION", "int8")
    claim_level = os.environ.get("E1_NPU_CLAIM_LEVEL", "L4_DEV_BOARD")
    observed_tops = (macs * 2.0) / (cycles / hz) / 1e12

    proof = {
        "schema": "eliza.e1_npu_nnapi_capability.v1",
        "date_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "target": target,
        "generated_by": generated_by,
        "accelerator_name": "e1-npu",
        "capability": {
            "claim_level": claim_level,
            "precision": precision,
            "operator_set": ["CONV_2D", "DEPTHWISE_CONV_2D", "FULLY_CONNECTED"],
            "contract_source": "sw/platform/e1_platform_contract.json",
        },
        "nnapi": {
            "accelerator_name": "e1-npu",
            "delegated_node_count": delegated,
            "total_node_count": total,
            "cpu_fallback_percent": 0,
            "unsupported_op_count": 0,
        },
        "dataflow": {
            "name": dataflow_name,
            "description": os.environ.get("E1_NPU_DATAFLOW_DESCRIPTION", dataflow_name),
        },
        "dma": {
            "path": "hardware_dma",
            "bytes_read": bytes_read,
            "bytes_written": bytes_written,
            "trace_bytes": transcripts["dma_trace"]["bytes"],
        },
        "measurements": {
            "macs_per_inference": macs,
            "npu_cycles": cycles,
            "npu_hz": hz,
            "observed_tops": observed_tops,
            "tops_formula": "observed_tops = macs_per_inference * 2 / (npu_cycles / npu_hz) / 1e12",
        },
        "capture": {"commands": CAPTURE_COMMANDS},
        "model_artifacts": {
            "benchmarks/models/mobile_smoke.tflite": {"sha256": sha(model)}
        },
        "transcripts": transcripts,
    }
    proof_json = proof_json if proof_json.is_absolute() else root / proof_json
    proof_json.parent.mkdir(parents=True, exist_ok=True)
    proof_json.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest["proof_json"] = {"path": rel(proof_json), "sha256": sha(proof_json), "bytes": proof_json.stat().st_size}
    manifest["status"] = "proof_json_written"

(out_dir / "nnapi-capture-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)

if marker_errors:
    raise SystemExit("\n".join(marker_errors))
PY

printf 'e1-npu NNAPI transcripts captured under %s\n' "$out_dir"
if [ "${E1_NPU_WRITE_PROOF_JSON:-0}" = "1" ]; then
	printf 'e1-npu NNAPI proof JSON written to %s\n' "$proof_json"
fi
if [ "$refresh_android_manifest" = "1" ]; then
	set +e
	python3 "$repo_root/scripts/assemble_e1_npu_android_proof_manifest.py"
	assemble_rc=$?
	set -e
	if [ "$assemble_rc" -ne 0 ] && [ "$assemble_rc" -ne 2 ]; then
		exit "$assemble_rc"
	fi
fi
printf 'Next: run scripts/check_e1_npu_nnapi_proof.py%s.\n' "${E1_NPU_WRITE_PROOF_JSON:+ --probe-adb}"
