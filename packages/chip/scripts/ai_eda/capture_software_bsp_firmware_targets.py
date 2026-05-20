#!/usr/bin/env python3
"""Capture dry-run software BSP, firmware, and boot-simulator AI targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/software_bsp_firmware_targets"
CLAIM_BOUNDARY = "software_bsp_firmware_target_capture_only_no_boot_bsp_or_perf_claim"

INPUT_ARTIFACTS = (
    "fw/boot-rom/reset.S",
    "fw/boot-rom/linker.ld",
    "fw/boot-rom/Makefile",
    "fw/boot-rom/check_boot_rom.py",
    "docs/arch/boot-rom-spec.md",
    "docs/arch/linux-capable-cpu-contract.md",
    "docs/rtl/open_rtl_prototype_path.md",
    "verify/rtl_gap_work_order.yaml",
    "sw/linux/dts/eliza-e1.dts",
    "sw/linux/dts/eliza-e1-qemu.dts",
    "sw/platform/generated/e1-platform.dtsi",
    "sw/linux/drivers/e1/e1-npu.c",
    "sw/linux/drivers/e1/e1-dma.c",
    "sw/linux/scripts/import-linux-bsp.sh",
    "sw/linux/scripts/capture-linux-bsp-evidence.sh",
    "sw/opensbi/scripts/import-opensbi-platform.sh",
    "docs/sw/opensbi/capture-opensbi-evidence.sh",
    "docs/sw/u-boot/capture-u-boot-evidence.sh",
    "scripts/run_qemu.sh",
    "scripts/run_renode.sh",
    "scripts/check_software_bsp.py",
    "scripts/check_software_bsp_evidence.py",
    "scripts/check_linux_platform_contract.py",
    "scripts/check_chipyard_verilator_linux_smoke.py",
)

OPTIONAL_COMMANDS = (
    "qemu-system-riscv64",
    "renode",
    "dtc",
    "riscv64-linux-gnu-gcc",
    "riscv64-unknown-elf-gcc",
    "cppcheck",
    "afl-fuzz",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "jsonschema",
    "networkx",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "path": path_text,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def command_entry(name: str) -> dict[str, str | None]:
    resolved = shutil.which(name)
    return {
        "command": name,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


def module_entry(name: str) -> dict[str, str]:
    return {
        "module": name,
        "status": "PRESENT" if importlib.util.find_spec(name) else "MISSING",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.software_bsp_firmware_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_BOOT_OR_BSP_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "llm-firmware-validation",
            "eok-riscv-kernel-optimization",
            "intrintrans-rvv",
            "autodriver-drivebench",
            "os-r1-kernel-tuning",
            "autoos-kernel-config",
            "firmhive",
            "adfemu-firmware-fuzzing",
            "opensbi",
            "u-boot",
            "mcp4eda",
        ],
        "policy": {
            "changes_firmware": False,
            "changes_bsp": False,
            "changes_device_tree": False,
            "changes_linux_driver": False,
            "changes_bootloader": False,
            "runs_qemu": False,
            "runs_renode": False,
            "runs_external_build": False,
            "downloads_external_assets": False,
            "generates_patch": False,
            "prediction_generated": False,
            "boot_claim_allowed": False,
            "bsp_claim_allowed": False,
            "kernel_perf_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "boot-rom-and-opensbi-handoff-corpus",
                "status": "CAPTURED_NOT_PATCHED",
                "target": "hash boot ROM, OpenSBI handoff, and firmware evidence contracts before any LLM patch loop",
                "acceptance_gates": [
                    "make bootrom-check",
                    "make software-bsp-check",
                    "make qemu-check",
                ],
            },
            {
                "id": "linux-bsp-device-tree-review",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future cited review of DTS, platform headers, and E1 Linux driver scaffolds",
                "acceptance_gates": [
                    "make linux-bsp-check",
                    "make linux-handoff-check",
                    "make software-bsp-evidence-check",
                ],
            },
            {
                "id": "qemu-renode-firmware-validation-loop",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future validation-and-patching loop gated by QEMU/Renode transcripts and static analysis",
                "acceptance_gates": [
                    "make qemu-check",
                    "make renode-check",
                    "make software-bsp-test",
                ],
            },
            {
                "id": "riscv-kernel-and-rvv-optimization-watch",
                "status": "CAPTURED_NOT_OPTIMIZED",
                "target": "future advisory optimization for RISC-V kernels or RVV code after runnable benchmark logs exist",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "make benchmark-sim-metrics",
                    "make e1-npu-nnapi-proof-check",
                ],
            },
            {
                "id": "linux-driver-coevolution-watch",
                "status": "CAPTURED_NOT_PATCHED",
                "target": "future AUTODRIVER/DRIVEBENCH-style Linux driver co-evolution requires exact dataset/code revisions, kernel and driver source hashes, generated-patch quarantine, static analysis, compile logs, QEMU/Renode transcripts, platform-contract checks, and reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/check_linux_platform_contract.py",
                    "make linux-bsp-check",
                    "make software-bsp-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "kernel-config-tuning-watch",
                "status": "CAPTURED_NOT_TUNED",
                "target": "future OS-R1 or AutoOS-style kernel configuration tuning requires pinned kernel revisions, baseline/generated .config hashes, Kconfig validation, workload manifests, QEMU/Renode or hardware logs, power/performance replay, and reviewer disposition",
                "acceptance_gates": [
                    "make linux-bsp-check",
                    "make qemu-check",
                    "make power-thermal-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "firmware-security-and-fuzzing-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future FIRMHIVE or ADFEmu-style firmware security/fuzzing work requires pinned assets, firmware and driver hashes, corpus licenses, peripheral/DMA model manifests, seed/crash logs, generated-finding quarantine, replay, and security reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "make software-bsp-check",
                    "make qemu-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no executable E1 Linux boot transcript through RTL-equivalent simulator",
            "no imported external Linux/OpenSBI/U-Boot tree with pinned revision and evidence logs",
            "no approved LLM firmware patch workflow or reviewer signoff contract",
            "no QEMU/Renode transcript tied to the E1 RTL-equivalent memory map and device tree",
            "no static-analysis, fuzzing, or runtime-monitoring gate for generated firmware patches",
            "no runnable RISC-V kernel/RVV benchmark corpus for E1 NPU software optimization",
            "no license-reviewed Linux driver co-evolution benchmark or agent workflow with generated patch quarantine, E1 driver tests, and platform-contract replay",
            "no approved Linux kernel configuration tuning workflow with pinned kernel revision, baseline/generated config hashes, workload logs, power evidence, and reviewer disposition",
            "no approved firmware security/fuzzing workflow with firmware corpus license review, peripheral/DMA model, crash triage, replay logs, and security reviewer disposition",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.software_bsp_firmware.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
