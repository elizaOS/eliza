#!/usr/bin/env python3
"""Repo-local gate for the minimum Linux side of the Linux+NPU target."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/project/minimum-linux-npu-target.md"
REPORT = ROOT / "build/reports/minimum-linux-kernel-target.json"
LINUX_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
LINUX_EXTERNAL_STATUS = ROOT / "docs/evidence/linux/linux-external-bsp-status.json"

REQUIRED_LOCAL_ARTIFACTS = {
    "linux_bsp_readme": "docs/sw/linux/README.md",
    "linux_import_script": "sw/linux/scripts/import-linux-bsp.sh",
    "linux_evidence_capture": "sw/linux/scripts/capture-linux-bsp-evidence.sh",
    "linux_boot_artifact_manifest": "docs/evidence/linux/eliza-linux-boot-artifacts.json",
    "linux_boot_artifact_checker": "scripts/check_linux_boot_artifacts.py",
    "linux_external_bsp_checker": "scripts/check_linux_external_bsp.py",
    "cpu_ap_boot_readiness_checker": "scripts/check_cpu_ap_boot_readiness.py",
    "linux_dts": "sw/linux/dts/eliza-e1.dts",
    "linux_npu_driver": "sw/linux/drivers/e1/e1-npu.c",
    "linux_dma_driver": "sw/linux/drivers/e1/e1-dma.c",
    "linux_mmio_smoke_source": "sw/linux/tests/e1-mmio-smoke.c",
    "linux_npu_smoke_source": "sw/linux/tests/e1-npu-smoke.c",
}
REQUIRED_EVIDENCE = {
    "chipyard_generated_ap_linux_smoke": "build/chipyard/eliza_rocket/verilator-linux-smoke.log",
    "linux_kernel_build": "docs/evidence/linux/eliza_e1_kernel_build.log",
    "linux_dtb_check": "docs/evidence/linux/eliza_e1_dtb_check.log",
    "opensbi_handoff": "docs/evidence/linux/opensbi_fw_dynamic_handoff.log",
    "serial_boot_log": "docs/evidence/linux/eliza_e1_serial_boot.log",
    "linux_mmio_smoke": "docs/evidence/linux/e1-mmio-smoke.log",
}
REQUIRED_DTS_TOKENS = {
    "chosen": "chosen",
    "bootargs": "console=",
    "stdout": "stdout-path",
    "cpu": "cpu@0",
    "memory": "memory@80000000",
    "clint": "clint@2000000",
    "plic": "interrupt-controller@c000000",
    "uart_console": "serial@10001000",
    "dma": "dma@10010000",
    "npu": "npu@10020000",
    "display": "display@10030000",
}
REQUIRED_DOC_TERMS = {
    "not qemu-virt-only",
    "OpenSBI",
    "Linux version",
    "/dev/e1-npu",
    "GEMM_S8",
    "input hash",
    "output hash",
    "CPU-only fallback",
}


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
        data = json.loads(read(path))
    except json.JSONDecodeError:
        return {"_invalid_json": True}
    return data if isinstance(data, dict) else {"_invalid_json": True}


def check_evidence(path: Path) -> dict[str, Any]:
    blocked = path.with_suffix(path.suffix + ".BLOCKED")
    if path.is_file() and path.stat().st_size > 0:
        text = read(path)
        if "eliza-evidence: status=PASS" not in text:
            return {
                "status": "blocked",
                "path": rel(path),
                "bytes": path.stat().st_size,
                "reason": "missing eliza-evidence: status=PASS",
            }
        return {"status": "present", "path": rel(path), "bytes": path.stat().st_size}
    if blocked.is_file():
        text = read(blocked).strip()
        valid = bool(text) and text.splitlines()[0].lower().startswith("reason:")
        return {
            "status": "blocked" if valid else "invalid_blocked_marker",
            "path": rel(path),
            "blocked_marker": rel(blocked),
            "reason": text.splitlines()[0] if text else "",
        }
    status_report = path.with_suffix(".json")
    report = load_json(status_report)
    if report.get("status") == "blocked":
        blockers = report.get("blockers")
        reason = ""
        if isinstance(blockers, list) and blockers:
            reason = str(blockers[0])
        elif isinstance(report.get("progress"), dict):
            reason = str(report["progress"].get("next_step", ""))
        return {
            "status": "blocked",
            "path": rel(path),
            "blocked_report": rel(status_report),
            "reason": reason or "companion status report is blocked",
        }
    return {"status": "missing", "path": rel(path), "blocked_marker": rel(blocked)}


def collect() -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[str] = []
    doc_text = read(DOC)
    if not doc_text:
        errors.append(f"missing checklist doc: {rel(DOC)}")
    else:
        errors.extend(
            f"checklist missing required term: {term}"
            for term in REQUIRED_DOC_TERMS
            if term not in doc_text
        )

    artifacts = {
        name: {"path": path, "exists": (ROOT / path).exists()}
        for name, path in REQUIRED_LOCAL_ARTIFACTS.items()
    }
    for name, item in artifacts.items():
        if not item["exists"]:
            errors.append(f"missing local artifact {name}: {item['path']}")

    dts_text = read(LINUX_DTS)
    dts_checks = {name: token in dts_text for name, token in REQUIRED_DTS_TOKENS.items()}
    for name, passed in dts_checks.items():
        if not passed:
            errors.append(f"Linux DTS missing {name}: {REQUIRED_DTS_TOKENS[name]}")

    subprocess.run(
        [sys.executable, "scripts/check_linux_external_bsp.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    linux_external_bsp = load_json(LINUX_EXTERNAL_STATUS)
    if not linux_external_bsp:
        errors.append(f"missing Linux external BSP status report: {rel(LINUX_EXTERNAL_STATUS)}")

    evidence = {name: check_evidence(ROOT / path) for name, path in REQUIRED_EVIDENCE.items()}
    for name, item in evidence.items():
        if item["status"] == "blocked":
            blockers.append(f"{name}: {item.get('reason', '')}")
        elif item["status"] != "present":
            errors.append(f"{name} evidence state is {item['status']}: {item['path']}")

    return {
        "schema": "eliza.minimum_linux_kernel_target.v1",
        "status": "fail" if errors else ("blocked" if blockers else "pass"),
        "claim_boundary": "minimum target gate only; not generated-AP boot evidence by itself",
        "checklist": rel(DOC),
        "local_artifacts": artifacts,
        "dts_checks": dts_checks,
        "linux_external_bsp": linux_external_bsp,
        "evidence": evidence,
        "errors": errors,
        "blockers": blockers,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    report = collect()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"STATUS: {report['status'].upper()} minimum_linux_kernel_target")
        print(f"  report: {rel(REPORT)}")
        for error in report["errors"]:
            print(f"  - {error}")
        for blocker in report["blockers"]:
            print(f"  - {blocker}")
    if report["status"] == "fail":
        return 1
    if report["status"] == "blocked" and args.strict:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
