#!/usr/bin/env python3
"""Tests for scripts/android/capture_e1_npu_nnapi_evidence.sh."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "scripts/android/capture_e1_npu_nnapi_evidence.sh"
CHECK = ROOT / "scripts/check_e1_npu_nnapi_proof.py"
PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"


def write_fake_adb(path: Path, include_accelerator: bool = True) -> None:
    accelerator = "e1-npu" if include_accelerator else "cpu-reference"
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'case "${1:-}" in\n'
        "  devices)\n"
        "    printf 'List of devices attached\\nabc123\\tdevice\\n'\n"
        "    ;;\n"
        "  push)\n"
        "    exit 0\n"
        "    ;;\n"
        "  shell)\n"
        "    shift\n"
        '    if [ "${1:-}" = cmd ] && [ "${2:-}" = neuralnetworks ]; then\n'
        f"      printf 'NNAPI accelerator: {accelerator}\\n'\n"
        '    elif [ "${1:-}" = benchmark_model ]; then\n'
        "      printf '%s\\n' \"$*\"\n"
        f"      printf 'NNAPI delegated accelerator {accelerator}\\n'\n"
        '    elif [ "${1:-}" = cat ]; then\n'
        f"      printf '{accelerator} DMA bytes_read=1024 bytes_written=2048\\n'\n"
        "    else\n"
        "      printf 'unknown adb shell command: %s\\n' \"$*\" >&2\n"
        "      exit 1\n"
        "    fi\n"
        "    ;;\n"
        "  *)\n"
        "    printf 'unknown adb command: %s\\n' \"$*\" >&2\n"
        "    exit 1\n"
        "    ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def run_capture(
    temp_root: Path, include_accelerator: bool = True
) -> subprocess.CompletedProcess[str]:
    bin_dir = temp_root / "bin"
    bin_dir.mkdir()
    write_fake_adb(bin_dir / "adb", include_accelerator=include_accelerator)
    out_dir = temp_root / "evidence"
    proof = temp_root / "e1_npu_nnapi.proof.json"
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
            "E1_NPU_NNAPI_EVIDENCE_DIR": str(out_dir),
            "E1_NPU_REFRESH_ANDROID_MANIFEST": "0",
            "E1_NPU_WRITE_PROOF_JSON": "1",
            "E1_NPU_NNAPI_PROOF_JSON": str(proof),
            "E1_NPU_MACS_PER_INFERENCE": "1000",
            "E1_NPU_CYCLES": "1000",
            "E1_NPU_HZ": "1000000000",
            "E1_NPU_DMA_BYTES_READ": "1024",
            "E1_NPU_DMA_BYTES_WRITTEN": "2048",
            "E1_NPU_NNAPI_DELEGATED_NODE_COUNT": "1",
            "E1_NPU_NNAPI_TOTAL_NODE_COUNT": "1",
            "E1_NPU_DATAFLOW_NAME": "unit-test-hardware-dma",
            "E1_NPU_GENERATED_BY": "unit-test-fake-adb",
            "E1_NPU_TARGET": "unit-test-android-target",
        }
    )
    return subprocess.run(
        [str(CAPTURE)],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_capture_writes_validator_compatible_proof_json() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        temp_root = Path(td)
        result = run_capture(temp_root)
        if result.returncode != 0:
            raise AssertionError(result.stdout)

        manifest = json.loads((temp_root / "evidence/nnapi-capture-manifest.json").read_text())
        if manifest.get("status") != "proof_json_written":
            raise AssertionError(json.dumps(manifest, indent=2))
        proof = temp_root / "e1_npu_nnapi.proof.json"
        if not proof.is_file():
            raise AssertionError("capture did not write proof JSON")

        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        for bench in plan["benchmarks"]:
            if bench["name"] == "tflite_e1_npu":
                bench["capability_artifacts"][0]["path"] = str(proof.relative_to(ROOT))
        plan_path = temp_root / "benchmark_plan.json"
        status_path = temp_root / "status.json"
        plan_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
        check = subprocess.run(
            [
                sys.executable,
                str(CHECK),
                "--config",
                str(plan_path),
                "--status-json",
                str(status_path),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        status = json.loads(status_path.read_text(encoding="utf-8"))
        if check.returncode != 0 or not status.get("proof_valid"):
            raise AssertionError(check.stdout + "\n" + json.dumps(status, indent=2))


def test_capture_refuses_marker_missing_proof_json() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        temp_root = Path(td)
        result = run_capture(temp_root, include_accelerator=False)
        if result.returncode == 0:
            raise AssertionError("capture should fail when e1-npu transcript markers are absent")
        manifest_path = temp_root / "evidence/nnapi-capture-manifest.json"
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            if manifest.get("status") != "blocked":
                raise AssertionError(json.dumps(manifest, indent=2))
        if (temp_root / "e1_npu_nnapi.proof.json").exists():
            raise AssertionError("capture wrote proof JSON despite missing e1-npu markers")


def test_capture_refreshes_android_manifest_by_default() -> None:
    text = CAPTURE.read_text(encoding="utf-8")
    if 'refresh_android_manifest="${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}"' not in text:
        raise AssertionError("NNAPI capture must default to refreshing the Android proof manifest")
    if "scripts/assemble_e1_npu_android_proof_manifest.py" not in text:
        raise AssertionError("NNAPI capture must invoke the Android proof manifest assembler")


def main() -> int:
    for test in (
        test_capture_writes_validator_compatible_proof_json,
        test_capture_refuses_marker_missing_proof_json,
        test_capture_refreshes_android_manifest_by_default,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
