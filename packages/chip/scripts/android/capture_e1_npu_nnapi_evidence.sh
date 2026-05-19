#!/usr/bin/env bash
# Capture Android NNAPI e1-npu transcripts from a real connected target.

set -euo pipefail

repo_root="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
out_dir="${E1_NPU_NNAPI_EVIDENCE_DIR:-$repo_root/docs/evidence/android/e1-npu}"
model="${E1_NPU_TFLITE_MODEL:-$repo_root/benchmarks/models/mobile_smoke.tflite}"
device_model="${E1_NPU_DEVICE_MODEL:-/data/local/tmp/mobile_smoke.tflite}"
accelerator="${E1_NPU_NNAPI_ACCELERATOR:-e1-npu}"
dma_trace="${E1_NPU_DMA_TRACE:-/sys/bus/platform/devices/10020000.npu/dma_trace}"

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

python3 - "$repo_root" "$out_dir" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
out_dir = Path(sys.argv[2])

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
manifest = {
    "schema": "eliza.e1_npu_nnapi_capture_manifest.v1",
    "status": "captured_transcripts_only",
    "claim_boundary": "not_a_capability_proof_until_benchmarks/capabilities/e1_npu_nnapi.proof.json_is_reviewed",
    "transcripts": {
        name: {"path": rel(path), "sha256": sha(path), "bytes": path.stat().st_size}
        for name, path in logs.items()
    },
}
(out_dir / "nnapi-capture-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

printf 'e1-npu NNAPI transcripts captured under %s\n' "$out_dir"
printf 'Next: create benchmarks/capabilities/e1_npu_nnapi.proof.json from reviewed target counters, then run scripts/check_e1_npu_nnapi_proof.py.\n'
