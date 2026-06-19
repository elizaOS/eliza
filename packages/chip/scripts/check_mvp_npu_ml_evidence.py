#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/mvp_npu_ml_smoke.json"
TRANSCRIPT = ROOT / "build/reports/mvp_npu_ml_smoke.log"
SCALE_REPORT = ROOT / "build/reports/mvp_npu_scale_sim.json"
MODEL = ROOT / "benchmarks/models/mobile_smoke.tflite"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_integrated_claim_allowed": False,
    "android_nnapi_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

sys.path.insert(0, str(ROOT / "compiler/runtime"))
from e1_npu_runtime import golden_gemm_s8  # noqa: E402
from test_e1_npu_runtime_sim import E1NpuMmioSim  # noqa: E402


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def artifact(path: Path) -> dict[str, Any]:
    item: dict[str, Any] = {"path": rel(path), "exists": path.is_file()}
    if path.is_file():
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        item.update({"sha256": digest.hexdigest(), "bytes": path.stat().st_size})
    return item


def run_scale_model() -> tuple[int, str]:
    proc = subprocess.run(
        [
            sys.executable,
            "benchmarks/sim/run_npu_scale_sim.py",
            "--config",
            "min_real_v1_16mac_128kib",
            "--out",
            str(SCALE_REPORT),
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return proc.returncode, proc.stdout


def run_smoke() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]
    sim = E1NpuMmioSim()
    observed = sim.runtime.gemm_s8(a, b)
    expected = golden_gemm_s8(a, b)
    perf = sim.runtime.perf()
    input_sha = hash_bytes(canonical({"a": a, "b": b, "workload": "gemm_s8_int8_2x2x3"}))
    output_sha = hash_bytes(canonical({"observed": observed}))
    scale_code, scale_stdout = run_scale_model()

    errors: list[str] = []
    if observed != expected:
        errors.append("observed GEMM output does not match golden output")
    if perf.get("errors") != 0:
        errors.append(f"NPU perf errors is non-zero: {perf.get('errors')}")
    if perf.get("macs") != 12:
        errors.append(f"NPU perf macs expected 12, got {perf.get('macs')}")
    if scale_code != 0:
        errors.append("NPU scale model command failed")
    if not SCALE_REPORT.is_file():
        errors.append(f"missing scale report: {rel(SCALE_REPORT)}")

    status = "pass" if not errors else "fail"
    lines = [
        "eliza-evidence: target=local_e1_npu_runtime_sim",
        "eliza-evidence: wrapper=scripts/check_mvp_npu_ml_evidence.py --run",
        "eliza-evidence: claim_boundary=local NPU runtime/scratchpad evidence; not Linux-integrated generated-AP evidence",
        "eliza-evidence: npu_path=e1_npu_mmio_scratchpad",
        "eliza-evidence: workload=gemm_s8_int8_2x2x3",
        f"eliza-evidence: input_sha256={input_sha}",
        f"eliza-evidence: output_sha256={output_sha}",
        "eliza-evidence: observed_matrix=" + json.dumps(observed, separators=(",", ":")),
        "eliza-evidence: expected_matrix=" + json.dumps(expected, separators=(",", ":")),
        "eliza-evidence: perf=" + json.dumps(perf, sort_keys=True, separators=(",", ":")),
        f"eliza-evidence: scale_report={rel(SCALE_REPORT)}",
        f"eliza-evidence: status={status.upper()}",
        f"RESULT={0 if status == 'pass' else 1}",
    ]
    if scale_stdout.strip():
        lines += [
            "eliza-evidence: scale_model_stdout_begin",
            scale_stdout.rstrip(),
            "eliza-evidence: scale_model_stdout_end",
        ]
    TRANSCRIPT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    data = {
        "schema": "eliza.mvp_npu_ml_smoke.v1",
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "npu_ml_smoke_claim": status == "pass",
        "integrated_linux_npu_ml_claim": False,
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "This proves a deterministic local e1 NPU runtime/scratchpad INT8 GEMM "
            "smoke only. The minimum Linux+NPU target still requires the same workload "
            "markers in a generated Eliza AP Linux boot transcript."
        ),
        "command": [sys.executable, "scripts/check_mvp_npu_ml_evidence.py", "--run"],
        "workload": {
            "name": "gemm_s8_int8_2x2x3",
            "input_sha256": input_sha,
            "output_sha256": output_sha,
            "observed_matrix": observed,
            "expected_matrix": expected,
            "perf": perf,
        },
        "artifacts": {
            "transcript": artifact(TRANSCRIPT),
            "scale_report": artifact(SCALE_REPORT),
            "model": artifact(MODEL),
        },
        "blockers_to_integrated_linux_npu_ml": [
            {
                "name": "generated_ap_linux_npu_ml_transcript",
                "detail": "missing generated-AP Linux transcript markers for e1 NPU device and gemm_s8_int8_2x2x3 PASS",
                "next_command": "python3 scripts/run_mvp_simulator.py",
            }
        ],
        "errors": errors,
    }
    tmp = REPORT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(REPORT)
    return validate()


def validate() -> int:
    if not REPORT.is_file():
        print(f"STATUS: BLOCKED mvp.npu_ml_smoke - missing {rel(REPORT)}")
        print("  next_command: python3 scripts/check_mvp_npu_ml_evidence.py --run")
        return 2
    try:
        data = json.loads(REPORT.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"STATUS: FAIL mvp.npu_ml_smoke - invalid JSON: {exc}")
        return 1

    errors: list[str] = []
    if data.get("schema") != "eliza.mvp_npu_ml_smoke.v1":
        errors.append("schema mismatch")
    if data.get("status") not in {"pass", "blocked", "fail"}:
        errors.append("invalid status")
    if data.get("integrated_linux_npu_ml_claim") is not False:
        errors.append("integrated_linux_npu_ml_claim must remain false for local-only smoke")
    for flag in sorted(FALSE_CLAIM_FLAGS):
        if data.get(flag) is not False:
            errors.append(f"{flag} must be false")
    if not TRANSCRIPT.is_file():
        errors.append(f"missing transcript: {rel(TRANSCRIPT)}")
    else:
        text = TRANSCRIPT.read_text(encoding="utf-8", errors="replace")
        for marker in (
            "eliza-evidence: target=local_e1_npu_runtime_sim",
            "eliza-evidence: npu_path=e1_npu_mmio_scratchpad",
            "eliza-evidence: workload=gemm_s8_int8_2x2x3",
            "eliza-evidence: input_sha256=",
            "eliza-evidence: output_sha256=",
            "eliza-evidence: observed_matrix=",
            "eliza-evidence: status=PASS",
        ):
            if marker not in text:
                errors.append(f"{rel(TRANSCRIPT)} lacks required marker: {marker}")
    workload = data.get("workload")
    if not isinstance(workload, dict):
        errors.append("workload must be object")
    elif workload.get("observed_matrix") != workload.get("expected_matrix"):
        errors.append("observed matrix must match expected matrix")
    for key in ("transcript", "scale_report", "model"):
        item = (
            data.get("artifacts", {}).get(key) if isinstance(data.get("artifacts"), dict) else None
        )
        if not isinstance(item, dict) or item.get("exists") is not True:
            errors.append(f"artifact missing: {key}")
    if SCALE_REPORT.is_file():
        try:
            scale_data = json.loads(SCALE_REPORT.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{rel(SCALE_REPORT)} is invalid JSON: {exc}")
        else:
            if scale_data.get("status") != "pass":
                errors.append(f"{rel(SCALE_REPORT)} status must be pass")
    if errors:
        print("STATUS: FAIL mvp.npu_ml_smoke")
        for error in errors:
            print(f"  - {error}")
        return 1
    if data.get("status") == "pass":
        print("STATUS: PASS mvp.npu_ml_smoke")
        print(f"  transcript: {rel(TRANSCRIPT)}")
        print(f"  manifest: {rel(REPORT)}")
        return 0
    print("STATUS: BLOCKED mvp.npu_ml_smoke")
    return 2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    return run_smoke() if args.run else validate()


if __name__ == "__main__":
    raise SystemExit(main())
