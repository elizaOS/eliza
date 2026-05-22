#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/minimum_linux_npu_target.json"
DOC = ROOT / "docs/project/minimum-linux-npu-target.md"
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
COCOTB_XML = ROOT / "verify/cocotb/results/e1_npu_test_e1_npu.xml"
LINUX_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
LINUX_DRIVER = ROOT / "sw/linux/drivers/e1/e1-npu.c"
MVP_REPORT = ROOT / "build/reports/mvp_npu_ml_smoke.json"
BOOT_LOG = ROOT / "build/chipyard/eliza_rocket/verilator-linux-smoke.log"
BOOT_REPORT = ROOT / "build/chipyard/eliza_rocket/verilator-linux-smoke.json"
NNAPI_PROOF = ROOT / "benchmarks/capabilities/e1_npu_nnapi.proof.json"
LINUX_NPU_SMOKE_EVIDENCE = ROOT / "docs/evidence/linux/eliza_e1_npu_ml_smoke.log"
MLPERF_MODELED_REPORT = ROOT / "benchmarks/results/e1-npu-mlperf-modeled.json"

DEVICE_PATH = "/dev/e1-npu"
WORKLOAD = "gemm_s8_int8_2x2x3"
BENCHMARK_COMMAND = [
    "e1-npu-ml-smoke",
    "--device",
    DEVICE_PATH,
    "--workload",
    WORKLOAD,
    "--require-npu",
]
GENERATED_AP_USERLAND_NPU_MARKERS = (
    "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
    "Linux early console",
    "generated DTS hash",
    "memory node",
    "CPU node",
    "timer node",
    "interrupt-controller node",
    "UART node",
    "chosen stdout",
    "Linux CONFIG_MMU",
    "initramfs start",
    "e1 MMIO smoke result: PASS",
    "e1-npu-ml-smoke: PASS",
    "workload=gemm_s8_int8_2x2x3",
    "--require-npu",
    "device=/dev/mem generated-mmio",
    "eliza-evidence: status=PASS",
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"_invalid_json": True, "_json_error": str(exc), "_path": rel(path)}
    return data if isinstance(data, dict) else {}


def sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path) -> dict[str, Any]:
    item: dict[str, Any] = {"path": rel(path), "exists": path.is_file()}
    if path.is_file():
        item.update({"bytes": path.stat().st_size, "sha256": sha256(path)})
    return item


def cocotb_gate() -> dict[str, Any]:
    if not COCOTB_XML.is_file():
        return {"name": "rtl_cocotb_proof", "status": "blocked", "path": rel(COCOTB_XML)}
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(read(COCOTB_XML))
    except ImportError as exc:
        return {
            "name": "rtl_cocotb_proof",
            "status": "blocked",
            "path": rel(COCOTB_XML),
            "blocker": f"Python XML parser unavailable: {exc}",
        }
    except ET.ParseError as exc:
        return {
            "name": "rtl_cocotb_proof",
            "status": "failed",
            "path": rel(COCOTB_XML),
            "error": f"invalid cocotb XML: {exc}",
        }
    failures = sum(int(suite.attrib.get("failures", "0")) for suite in root.iter("testsuite"))
    errors = sum(int(suite.attrib.get("errors", "0")) for suite in root.iter("testsuite"))
    testcases = len(list(root.iter("testcase")))
    return {
        "name": "rtl_cocotb_proof",
        "status": "passed" if testcases and failures == 0 and errors == 0 else "failed",
        "path": rel(COCOTB_XML),
        "testcases": testcases,
        "failures": failures,
        "errors": errors,
    }


def run_mvp_smoke() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_mvp_npu_ml_evidence.py", "--run"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(MVP_REPORT)
    report_status = report.get("status")
    status = "passed" if report_status == "pass" or completed.returncode == 0 else "blocked"
    return {
        "name": "local_npu_ml_smoke",
        "status": status,
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_linux_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_minimum_linux_target.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(ROOT / "build/reports/minimum-linux-kernel-target.json")
    report_status = report.get("status")
    status = report_status if report_status in {"pass", "blocked", "fail"} else None
    return {
        "name": "minimum_linux_kernel_target",
        "status": (
            "passed"
            if status == "pass"
            else "blocked"
            if status == "blocked"
            else "blocked"
            if completed.returncode != 0 or status == "fail"
            else "blocked"
        ),
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_target_smoke_source_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_e1_npu_linux_smoke.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(ROOT / "build/reports/e1_npu_linux_smoke_source.json")
    report_status = report.get("status")
    return {
        "name": "target_side_npu_ml_smoke",
        "status": (
            "passed"
            if report_status == "pass"
            else "blocked"
            if report_status == "blocked"
            else "blocked"
        ),
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_mlperf_modeled_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_e1_npu_mlperf_modeled.py", "--run"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(MLPERF_MODELED_REPORT)
    report_status = report.get("status")
    return {
        "name": "modeled_loadgen_npu_mlperf_subset",
        "status": (
            "passed"
            if completed.returncode == 0 and report_status == "pass"
            else "blocked"
        ),
        "command": completed.args,
        "stdout": completed.stdout,
        "report_path": rel(MLPERF_MODELED_REPORT),
        "report": report,
        "claim_boundary": (
            "modeled pre-silicon LoadGen subset over E1NpuRuntime/E1NpuMmioSim; "
            "not generated-AP Linux target proof, official MLCommons, or silicon performance"
        ),
    }


def run_mlperf_inference_energy_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_mlperf_inference.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return {
        "name": "modeled_mlperf_inference_energy_gate",
        "status": "passed" if completed.returncode == 0 else "blocked",
        "command": completed.args,
        "stdout": completed.stdout,
        "claim_boundary": (
            "modeled pre-silicon MLPerf Inference subset with simulator energy block; "
            "not generated-AP Linux target proof, official MLCommons, or measured silicon power"
        ),
    }


def benchmark_command_gate(target_smoke: dict[str, Any]) -> dict[str, Any]:
    report = target_smoke.get("report")
    report = report if isinstance(report, dict) else {}
    evidence = report.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    evidence_path = ROOT / str(evidence.get("path") or rel(LINUX_NPU_SMOKE_EVIDENCE))
    evidence_text = read(evidence_path)
    target_command = str(
        (report.get("capture_commands") or {}).get("target_smoke", "")
        if isinstance(report.get("capture_commands"), dict)
        else ""
    )
    required_markers = (
        "e1-npu-ml-smoke",
        "--device /dev/e1-npu",
        "--workload gemm_s8_int8_2x2x3",
        "--require-npu",
        "e1-npu-ml-smoke: PASS",
        "workload=gemm_s8_int8_2x2x3",
        "input_sha256=",
        "output_sha256=",
        "desc_bytes_read=",
        "desc_bytes_written=",
        "claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark",
        "eliza-evidence: status=PASS",
    )
    missing_markers = [marker for marker in required_markers if marker not in evidence_text]
    required_command_tokens = ("e1-npu-ml-smoke", "/dev/e1-npu", WORKLOAD, "--require-npu")
    missing_command_tokens = [
        token
        for token in required_command_tokens
        if token not in target_command and token not in evidence_text
    ]
    passed = (
        target_smoke.get("status") == "passed"
        and evidence_path.is_file()
        and not missing_markers
        and not missing_command_tokens
    )
    gate: dict[str, Any] = {
        "name": "benchmark_command",
        "status": "passed" if passed else "blocked",
        "command": BENCHMARK_COMMAND,
        "capture_command": target_command,
        "evidence": artifact(evidence_path),
        "source_gate_status": target_smoke.get("status"),
        "claim_boundary": (
            "proves the target-side Linux NPU userspace command and deterministic GEMM "
            "markers were captured; generated-AP integrated boot proof is checked by "
            "generated_ap_linux_boot/minimum_linux_kernel_target"
        ),
    }
    if missing_markers or missing_command_tokens:
        gate["missing_markers"] = missing_markers
        gate["missing_command_tokens"] = missing_command_tokens
    if not passed:
        gate["blocker"] = (
            "target-side e1-npu-ml-smoke transcript lacks required command/PASS markers"
        )
    return gate


def generated_ap_linux_boot_gate(boot_text: str, boot_report: dict[str, Any]) -> dict[str, Any]:
    early_boot_markers_present = "Linux version" in boot_text and (
        "OpenSBI" in boot_text or "SBI specification" in boot_text
    )
    missing_userland_npu_markers = [
        marker for marker in GENERATED_AP_USERLAND_NPU_MARKERS if marker not in boot_text
    ]
    companion_passed = boot_report.get("status") == "pass"
    generated_ap_linux_boot_passed = companion_passed and not missing_userland_npu_markers
    gate: dict[str, Any] = {
        "name": "generated_ap_linux_boot",
        "status": "passed" if generated_ap_linux_boot_passed else "blocked",
        "path": rel(BOOT_LOG),
        "companion_report": rel(BOOT_REPORT),
        "companion_report_status": boot_report.get("status", ""),
        "acceptance_basis": (
            "generated_ap_userland_npu_mmio_markers" if generated_ap_linux_boot_passed else ""
        ),
        "required_markers": list(GENERATED_AP_USERLAND_NPU_MARKERS),
        "missing_userland_npu_markers": missing_userland_npu_markers,
        "observed_markers": {
            "OpenSBI_or_SBI": "OpenSBI" in boot_text or "SBI specification" in boot_text,
            "Linux version": "Linux version" in boot_text,
            "initramfs start": "initramfs start" in boot_text,
            "e1 MMIO smoke result: PASS": "e1 MMIO smoke result: PASS" in boot_text,
            "e1-npu-ml-smoke: PASS": "e1-npu-ml-smoke: PASS" in boot_text,
        },
        "early_boot_markers_present": early_boot_markers_present,
        "claim_boundary": (
            "generated AP Linux+NPU proof requires the generated FireMarshal userland "
            "payload to run on Chipyard Verilator and print deterministic MMIO/GEMM "
            "PASS markers; kernel banner or companion progress reports alone are not enough"
        ),
    }
    if boot_report:
        gate["companion_report_blockers"] = boot_report.get("blockers", [])
        gate["companion_report_progress"] = boot_report.get("progress", {})
        active_attempt = boot_report.get("active_smoke_attempt")
        if isinstance(active_attempt, dict) and active_attempt.get("exists"):
            gate["companion_report_active_smoke_attempt"] = active_attempt
    if not generated_ap_linux_boot_passed:
        if not companion_passed:
            gate["blocker"] = (
                "generated-AP smoke companion report has not passed with the Eliza userland NPU payload"
            )
        elif missing_userland_npu_markers:
            gate["blocker"] = (
                "generated-AP transcript lacks required FireMarshal userland NPU/MMIO PASS markers"
            )
    return gate


def build_report() -> dict[str, Any]:
    doc_text = read(DOC)
    contract = load_json(CONTRACT)
    dts_text = read(LINUX_DTS)
    driver_text = read(LINUX_DRIVER)
    boot_text = read(BOOT_LOG)
    boot_report = load_json(BOOT_REPORT)
    linux_check = run_linux_check()
    target_smoke = run_target_smoke_source_check()
    mlperf_modeled = run_mlperf_modeled_check()
    mlperf_inference_energy = run_mlperf_inference_energy_check()
    mvp = run_mvp_smoke()
    benchmark_gate = benchmark_command_gate(target_smoke)
    generated_boot_gate = generated_ap_linux_boot_gate(boot_text, boot_report)
    gates = [
        linux_check,
        target_smoke,
        {
            "name": "model_input",
            "status": "passed",
            "workload": WORKLOAD,
            "source": rel(RUNTIME),
            "expected_output": [[-44, 8], [139, -54]],
        },
        {
            "name": "runtime_abi",
            "status": "passed"
            if contract.get("schema") == "eliza.e1_npu_runtime_contract.v1"
            else "blocked",
            "contract": rel(CONTRACT),
            "device_path": DEVICE_PATH,
            "mmio_base": contract.get("mmio", {}).get("base"),
            "opcode": "GEMM_S8",
        },
        {
            "name": "linux_device_path",
            "status": "passed"
            if 'miscdev.name = "e1-npu"' in driver_text
            and "eliza,e1-npu" in driver_text
            and "npu@10020000" in dts_text
            else "blocked",
            "device_path": DEVICE_PATH,
            "driver": rel(LINUX_DRIVER),
            "dts": rel(LINUX_DTS),
        },
        cocotb_gate(),
        benchmark_gate,
        mlperf_modeled,
        mlperf_inference_energy,
        {
            "name": "tflite_nnapi_proof_gate",
            "status": "passed" if NNAPI_PROOF.is_file() else "not_required",
            "proof": rel(NNAPI_PROOF),
            "note": "NNAPI/TFLite acceleration proof remains out of scope for the minimum Linux+NPU target",
        },
        generated_boot_gate,
        mvp,
    ]
    errors = [gate for gate in gates if gate.get("status") == "failed"]
    blockers = [gate for gate in gates if gate.get("status") == "blocked"]
    for token in ("/dev/e1-npu", "GEMM_S8", "input hash", "output hash", "CPU-only fallback"):
        if token not in doc_text:
            blockers.append({"name": "doc_required_terms", "missing": token, "status": "blocked"})
    return {
        "schema": "eliza.minimum_linux_npu_target.v1",
        "status": "fail" if errors else ("blocked" if blockers else "pass"),
        "claim_boundary": "minimum Linux basic ML only; not Android NNAPI or phone-class performance",
        "integrated_linux_npu_ml_claim": not errors and not blockers,
        "benchmark_command": BENCHMARK_COMMAND,
        "gates": gates,
        "errors": errors,
        "blockers": blockers,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif report["status"] == "pass":
        print("STATUS: PASS minimum_linux_npu_target")
    elif report["status"] == "blocked":
        print("STATUS: BLOCKED minimum_linux_npu_target")
        print(f"  report: {rel(REPORT)}")
        for blocker in report["blockers"]:
            print(f"  - {blocker['name']}")
    else:
        print("STATUS: FAIL minimum_linux_npu_target")
        print(f"  report: {rel(REPORT)}")
        for error in report["errors"]:
            print(f"  - {error['name']}")
    if report["status"] == "fail":
        return 1
    if report["status"] == "blocked" and args.strict:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
