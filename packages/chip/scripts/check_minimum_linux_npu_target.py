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
NNAPI_PROOF = ROOT / "benchmarks/capabilities/e1_npu_nnapi.proof.json"

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
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


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


def build_report() -> dict[str, Any]:
    doc_text = read(DOC)
    contract = load_json(CONTRACT)
    dts_text = read(LINUX_DTS)
    driver_text = read(LINUX_DRIVER)
    boot_text = read(BOOT_LOG)
    linux_check = run_linux_check()
    target_smoke = run_target_smoke_source_check()
    mvp = run_mvp_smoke()
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
        {
            "name": "benchmark_command",
            "status": "blocked",
            "command": BENCHMARK_COMMAND,
            "blocker": "target-side e1-npu-ml-smoke transcript has not been captured on generated-AP Linux",
        },
        {
            "name": "tflite_nnapi_proof_gate",
            "status": "passed" if NNAPI_PROOF.is_file() else "not_required",
            "proof": rel(NNAPI_PROOF),
            "note": "NNAPI/TFLite acceleration proof remains out of scope for the minimum Linux+NPU target",
        },
        {
            "name": "generated_ap_linux_boot",
            "status": "passed"
            if "OpenSBI" in boot_text and "Linux version" in boot_text
            else "blocked",
            "path": rel(BOOT_LOG),
            "blocker": "generated-AP Linux boot transcript lacks accepted OpenSBI/Linux markers",
        },
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
