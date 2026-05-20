#!/usr/bin/env python3
"""Check target-side hello NPU Linux ML smoke wiring and transcript intake."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1_npu_linux_smoke_source.json"
SMOKE = ROOT / "sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c"
PACKAGE_CONFIG = ROOT / "sw/buildroot/package/e1-npu-ml-smoke/Config.in"
DRIVER = ROOT / "sw/linux/drivers/e1/e1-npu.c"
UAPI = ROOT / "sw/linux/drivers/e1/e1-npu-uapi.h"
DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
CONTRACT = ROOT / "sw/linux/drivers/e1/e1_platform_contract.h"
BUILDROOT_CONFIG = ROOT / "sw/buildroot/Config.in"
BUILDROOT_DEFCONFIG = ROOT / "sw/buildroot/configs/eliza_e1_defconfig"
LINUX_EVIDENCE = ROOT / "docs/evidence/linux/eliza_e1_npu_ml_smoke.log"

CAPTURE_COMMANDS = {
    "buildroot": "make BR2_EXTERNAL=$PWD/sw/buildroot eliza_e1_defconfig && make BR2_EXTERNAL=$PWD/sw/buildroot",
    "kernel_import": "sw/linux/scripts/import-linux-bsp.sh /path/to/linux",
    "target_smoke": "ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu",
    "capture_wrapper": "E1_NPU_ML_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu' sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot ml-smoke",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(problems: list[str], condition: bool, message: str) -> None:
    if not condition:
        problems.append(message)


def build_report() -> dict[str, Any]:
    smoke = read(SMOKE)
    driver = read(DRIVER)
    uapi = read(UAPI)
    dts = read(DTS)
    contract = read(CONTRACT)
    buildroot_config = read(BUILDROOT_CONFIG)
    package_config = read(PACKAGE_CONFIG)
    buildroot_defconfig = read(BUILDROOT_DEFCONFIG)
    problems: list[str] = []
    blockers: list[str] = []
    evidence: dict[str, Any] = {"path": rel(LINUX_EVIDENCE), "present": LINUX_EVIDENCE.is_file()}

    for path in (
        SMOKE,
        PACKAGE_CONFIG,
        DRIVER,
        UAPI,
        DTS,
        CONTRACT,
        BUILDROOT_CONFIG,
        BUILDROOT_DEFCONFIG,
    ):
        require(problems, path.is_file(), f"missing required source: {rel(path)}")

    require(problems, "e1-npu-ml-smoke" in smoke, "smoke source lacks command identity")
    require(problems, "--workload" in smoke, "smoke source lacks workload CLI option")
    require(problems, "--require-npu" in smoke, "smoke source lacks require-npu CLI option")
    require(problems, "E1_NPU_IOC_RUN_GEMM_S8" in smoke, "smoke does not use RUN_GEMM_S8")
    require(problems, "E1_NPU_OP_RELU4_S8" in smoke, "smoke does not use RELU4_S8")
    require(
        problems, "E1_NPU_IOC_GET_CONTRACT" in smoke, "smoke does not validate the runtime contract"
    )
    require(problems, "E1_NPU_IOC_GET_COUNTERS" in smoke, "smoke does not read counters")
    require(
        problems,
        "CPU-only" in smoke or "cpu-only" in smoke.lower(),
        "smoke must reject CPU-only fallback",
    )
    require(
        problems,
        "input_sha256" in smoke and "output_sha256" in smoke,
        "smoke lacks input/output hash markers",
    )
    require(problems, "E1_NPU_IOC_RUN_GEMM_S8" in uapi, "UAPI lacks RUN_GEMM_S8 ioctl")
    require(problems, "E1_NPU_OP_RELU4_S8" in uapi, "UAPI lacks RELU4_S8 opcode")
    require(problems, "E1_NPU_OP_VRELU_S8" in uapi, "UAPI lacks VRELU_S8 opcode")
    require(problems, "E1_NPU_IOC_GET_CONTRACT" in uapi, "UAPI lacks GET_CONTRACT ioctl")
    require(problems, "E1_NPU_IOC_SUBMIT_DESCRIPTORS" in uapi, "UAPI lacks descriptor submit ioctl")
    require(
        problems,
        "E1_NPU_DESC_BYTES_READ_OFFSET" in driver,
        "driver lacks descriptor bytes-read counter readout",
    )
    require(
        problems,
        "E1_NPU_DESC_BYTES_WRITTEN_OFFSET" in driver
        and "E1_NPU_DESC_READ_BEATS_OFFSET" in driver
        and "E1_NPU_DESC_WRITE_BEATS_OFFSET" in driver,
        "driver lacks descriptor write/read/write-beat counter readout",
    )
    require(
        problems,
        "E1_NPU_DESC_BYTES_WRITTEN_OFFSET" in contract
        and "E1_NPU_DESC_READ_BEATS_OFFSET" in contract
        and "E1_NPU_DESC_WRITE_BEATS_OFFSET" in contract,
        "Linux platform contract lacks descriptor write/read/write-beat counters",
    )
    require(
        problems,
        "desc_bytes_written" in uapi and "desc_read_beats" in uapi and "desc_write_beats" in uapi,
        "UAPI lacks descriptor write/read/write-beat counters",
    )
    require(
        problems, "E1_NPU_BASE 0x10020000u" in contract, "platform contract has unexpected NPU base"
    )
    require(problems, "eliza,e1-npu" in dts, "DTS lacks eliza,e1-npu compatible")
    require(
        problems,
        "package/e1-npu-ml-smoke/Config.in" in buildroot_config
        and (
            "BR2_PACKAGE_E1_NPU_ML_SMOKE" in package_config
            or "BR2_PACKAGE_HELLO_NPU_ML_SMOKE" in package_config
        ),
        "Buildroot package is not sourced or lacks BR2 symbol",
    )
    require(
        problems,
        "BR2_PACKAGE_E1_NPU_ML_SMOKE=y" in buildroot_defconfig,
        "Buildroot defconfig does not enable e1-npu-ml-smoke",
    )

    if not LINUX_EVIDENCE.is_file():
        blockers.append(f"missing target transcript: {rel(LINUX_EVIDENCE)}")
    else:
        text = read(LINUX_EVIDENCE)
        evidence.update({"bytes": LINUX_EVIDENCE.stat().st_size, "sha256": sha256(LINUX_EVIDENCE)})
        if LINUX_EVIDENCE.stat().st_size < 256:
            problems.append(f"{rel(LINUX_EVIDENCE)} is too small to be a target transcript")
        for marker in (
            "eliza-evidence: target=linux artifact=e1_npu_ml_smoke",
            "COMMAND=",
            "/usr/bin/e1-npu-ml-smoke",
            "--workload gemm_s8_int8_2x2x3",
            "--require-npu",
            "e1-npu-ml-smoke: PASS",
            "workload=gemm_s8_int8_2x2x3",
            "contract_version=1",
            "desc_bytes_read=",
            "desc_bytes_written=",
            "desc_read_beats=",
            "desc_write_beats=",
            "desc_timeout_count=",
            "claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark",
            "eliza-evidence: status=PASS",
        ):
            if marker not in text:
                problems.append(f"{rel(LINUX_EVIDENCE)} missing marker: {marker}")
        if re.search(r"CPU-only fallback|status=FAIL|not found|No such file", text, re.I):
            problems.append(f"{rel(LINUX_EVIDENCE)} contains failure or fallback text")

    return {
        "schema": "eliza.e1_npu_linux_smoke_source.v1",
        "status": "fail" if problems else ("blocked" if blockers else "pass"),
        "claim_boundary": "source wiring plus explicit target transcript gate; not NNAPI or hardware benchmark proof",
        "sources": {
            "smoke": rel(SMOKE),
            "driver": rel(DRIVER),
            "uapi": rel(UAPI),
            "dts": rel(DTS),
            "contract": rel(CONTRACT),
            "buildroot_config": rel(BUILDROOT_CONFIG),
            "package_config": rel(PACKAGE_CONFIG),
            "buildroot_defconfig": rel(BUILDROOT_DEFCONFIG),
        },
        "evidence": evidence,
        "capture_commands": CAPTURE_COMMANDS,
        "problems": problems,
        "blockers": blockers,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--require-pass", action="store_true")
    args = parser.parse_args()

    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"STATUS: {report['status'].upper()} hello_npu.linux_smoke_source")
        print(f"  report: {rel(REPORT)}")
        for problem in report["problems"]:
            print(f"  - {problem}")
        for blocker in report["blockers"]:
            print(f"  - {blocker}")

    if report["status"] == "fail":
        return 1
    if report["status"] == "blocked" and args.require_pass:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
