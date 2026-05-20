#!/usr/bin/env python3
"""Capture dry-run post-silicon, bring-up, and lab-debug AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/post_silicon_validation_targets"
CLAIM_BOUNDARY = "post_silicon_validation_target_capture_only_no_silicon_or_lab_claim"

INPUT_ARTIFACTS = (
    "verify/riscv-arch-tests/manifest.json",
    "scripts/run_qemu.sh",
    "scripts/run_renode.sh",
    "scripts/check_real_world_gates.py",
    "scripts/check_fpga_target.py",
    "scripts/check_fpga_release.py",
    "scripts/check_manufacturing_artifacts.py",
    "docs/arch/debug.md",
    "docs/security/debug-policy.md",
    "docs/evidence/linux/qemu-virt-linux-payload-plan.json",
    "docs/evidence/linux/linux-external-bsp-status.json",
    "docs/evidence/linux/eliza-linux-boot-artifacts.json",
    "build/reports/qemu_smoke.manifest",
    "build/reports/qemu_os_boot_attempt.json",
    "build/reports/linux_boot_artifacts.json",
    "board/fpga/artifact-manifest.yaml",
    "board/fpga/release_manifest.yaml",
    "board/fpga/e1_demo_fpga.yaml",
    "board/kicad/e1-demo/debug_io.kicad_sch",
    "package/e1-demo-pinout.yaml",
    "package/wifi/evidence-gates.yaml",
    "docs/manufacturing/release-manifest.yaml",
    "docs/manufacturing/board-package-evidence.yaml",
    "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json",
    "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json",
    "scripts/run_coremark.sh",
)

OPTIONAL_COMMANDS = (
    "qemu-system-riscv64",
    "renode",
    "verilator",
    "openocd",
    "sigrok-cli",
    "riscv64-unknown-elf-gcc",
    "riscv64-linux-gnu-gcc",
    "spike",
    "riscof",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "jsonschema",
    "networkx",
    "sklearn",
    "torch",
    "pandas",
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
        "schema": "eliza.ai_eda.post_silicon_validation_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_POST_SILICON_OR_LAB_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "symbolic-qed",
            "soc-trace-protocol-debug",
            "verilator",
            "spike-riscv-isa-sim",
            "sail-riscv",
            "riscv-formal",
            "riscv-dv",
            "riscof",
            "riscv-arch-test",
            "riscv-isacov",
            "lyra-riscv-fuzz",
            "difuzzrtl",
            "rfuzz-rtl",
            "cascade-riscv-fuzzer",
            "openxiangshan-xfuzz",
            "openxiangshan-difftest",
            "feriver-riscv",
            "opentitan-chip-tests",
            "riscv-debug-spec",
            "openocd",
            "sigrok-cli",
            "spacely-asic-validation",
            "ml-boot-failure-debug",
            "llm4sechw-debug",
            "llm4sechw-oshd",
            "chipbench-ai-aided-design",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_firmware": False,
            "changes_board": False,
            "changes_fpga": False,
            "generates_lab_script": False,
            "generates_test_binary": False,
            "runs_on_hardware": False,
            "runs_fpga_flow": False,
            "runs_qemu": False,
            "runs_renode": False,
            "runs_llm": False,
            "downloads_external_assets": False,
            "imports_external_tests": False,
            "prediction_generated": False,
            "silicon_bringup_claim_allowed": False,
            "post_silicon_debug_claim_allowed": False,
            "riscv_compliance_claim_allowed": False,
            "lab_measurement_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "riscv-compliance-and-random-validation-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future Verilator, Spike, Sail-RISC-V, riscv-formal, RISCOF, riscv-arch-test, riscv-dv, riscvISACOV, Lyra, DifuzzRTL, RFUZZ, Cascade, XFUZZ, DiffTest, or FERIVer use must be pinned and tied to a buildable E1-compatible DUT, ISS/reference, result signatures, coverage, and replayable logs",
                "acceptance_gates": [
                    "make platform-contract-check",
                    "make qemu-check",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                ],
            },
            {
                "id": "deterministic-riscv-reference-model-watch",
                "status": "CAPTURED_NOT_CONNECTED",
                "target": "future Spike, Sail-RISC-V, Verilator, or riscv-formal reference checks require E1 ISA/profile selection, CSR and memory-map policy, RVFI or trace adapters, command logs, signatures, and reviewer disposition",
                "acceptance_gates": [
                    "make platform-contract-check",
                    "make formal",
                    "make qemu-check",
                ],
            },
            {
                "id": "isa-coverage-and-fpga-fuzz-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future ISA coverage, generative RISC-V fuzzing, coverage-guided RTL fuzzing, co-simulation, or FPGA-assisted differential checking requires pinned profiles, generator/model/toolchain manifests, RVVI or trace adapters, DUT/reference revisions, instrumentation hashes, bitstream hashes where applicable, coverage logs, mismatch checkpoints, and reviewer disposition",
                "acceptance_gates": [
                    "make qemu-check",
                    "make fpga-check",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "qed-and-trace-debug-method-watch",
                "status": "CAPTURED_NOT_INSTRUMENTED",
                "target": "future QED or trace-analysis workflows must map observable traces to E1 protocol, firmware, and RTL hashes before any root-cause claim",
                "acceptance_gates": [
                    "make formal",
                    "make cocotb-contract",
                    "python3 scripts/ai_eda/capture_verification_debug_targets.py --run-id validation",
                ],
            },
            {
                "id": "qemu-renode-to-fpga-bridge-watch",
                "status": "CAPTURED_NOT_BRIDGED",
                "target": "future AI-assisted bring-up plans must reconcile QEMU/Renode transcripts with FPGA constraints, board revision, and hardware logs",
                "acceptance_gates": [
                    "make qemu-check",
                    "make renode-check",
                    "make fpga-check",
                ],
            },
            {
                "id": "riscv-debug-and-lab-instrumentation-watch",
                "status": "CAPTURED_NOT_CONNECTED",
                "target": "future OpenOCD, RISC-V debug, sigrok, and Spacely-style capture flows must be pinned to E1 debug policy, board debug IO, probe/instrument identity, command logs, raw acquisition hashes, and no-hardware-action authorization",
                "acceptance_gates": [
                    "make fpga-check",
                    "make manufacturing-artifacts-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "boot-failure-classification-watch",
                "status": "CAPTURED_NOT_CLASSIFIED",
                "target": "future ML/XAI classification of boot failures requires labeled local boot, power, reset, UART, and JTAG traces",
                "acceptance_gates": [
                    "make software-bsp-check",
                    "make power-thermal-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "llm-hardware-debug-benchmark-and-corpus-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future LLM hardware-debug datasets or benchmarks must stay quarantined until exact revisions, licenses, task manifests, overlap review, generated outputs, logs, and reviewer disposition exist",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "lab-release-evidence-watch",
                "status": "CAPTURED_NOT_MEASURED",
                "target": "future silicon or board lab automation must be promoted only through manufacturing, real-world, benchmark, and release gates",
                "acceptance_gates": [
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                    "make product-check",
                ],
            },
        ],
        "blocked_by": [
            "no E1 silicon, FPGA hardware transcript, JTAG log, or lab measurement corpus",
            "no pinned external RISCOF, riscv-arch-test, or riscv-dv checkout executed against a buildable E1-compatible DUT",
            "no pinned Verilator, Spike, Sail-RISC-V, or riscv-formal replay tied to E1 CPU wrappers, RVFI/trace adapters, ISA profile, CSR map, memory map, signatures, and reviewer disposition",
            "no RISC-V ISA compliance, random-instruction, or ISS co-simulation evidence tied to E1 CPU wrappers",
            "no pinned riscvISACOV/RVVI trace adapter, ISA coverage database, or coverage-gap disposition for E1",
            "no Lyra/FERIVer/DifuzzRTL/RFUZZ/Cascade/XFUZZ/DiffTest asset, generator seed/model/toolchain manifest, FPGA bitstream where applicable, ISS co-simulation checkpoint, differential failure log, or coverage replay evidence",
            "no trace schema for reset, boot, UART, JTAG, power, thermal, FPGA, or board observations",
            "no pinned OpenOCD board configuration, RISC-V debug module transcript, probe inventory, or sigrok acquisition profile",
            "no approved Spacely-style lab config, instrument inventory, waveform-to-stimulus transform, command log, raw capture hash, or hardware-action authorization",
            "no labeled boot-failure, post-silicon debug, or lab anomaly corpus for ML/XAI triage",
            "no approved LLM hardware-debug dataset or benchmark import with pinned revisions, licenses, task manifests, non-overlap review, replay logs, and reviewer disposition",
            "no approved workflow for AI-generated lab scripts, test binaries, FPGA bitstreams, or hardware actions",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.post_silicon_validation.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
