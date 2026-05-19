#!/usr/bin/env python3
"""Capture dry-run IP, register-map, and platform-contract automation targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/ip_register_contract_targets"
CLAIM_BOUNDARY = "ip_register_contract_capture_only_no_ip_import_or_register_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "sw/platform/e1_platform_contract.json",
    "sw/platform/generated/e1_platform_contract.h",
    "sw/linux/drivers/e1/e1_platform_contract.h",
    "docs/arch/memory-map.md",
    "docs/arch/android-contract.md",
    "docs/arch/npu-microarch.md",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "docs/spec-db/npu-2028-target.yaml",
    "scripts/gen_platform_artifacts.py",
    "scripts/check_platform_contract.py",
    "scripts/check_linux_platform_contract.py",
    "scripts/check_e1_npu_runtime_contract.py",
    "scripts/check_npu_2028_targets.py",
    "scripts/check_chipyard_generated_linux_contract.py",
    "rtl/top/e1_soc_top.sv",
    "rtl/top/e1_soc_integrated.sv",
    "rtl/top/e1_chip_top.sv",
    "rtl/iommu/e1_riscv_iommu_pkg.sv",
    "rtl/power/power_pkg.sv",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "jq",
    "peakrdl",
    "regtool.py",
    "fusesoc",
    "edalize",
    "bender",
    "siliconcompiler",
    "rggen",
    "verilator",
    "yosys",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "systemrdl",
    "peakrdl",
    "peakrdl_ipxact",
    "edalize",
    "siliconcompiler",
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
        "schema": "eliza.ai_eda.ip_register_contract_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_IP_REGISTER_CONTRACT_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "systemrdl-standard",
            "peakrdl",
            "peakrdl-ipxact",
            "opentitan-reggen",
            "ip-xact-standard",
            "fusesoc",
            "edalize",
            "bender",
            "siliconcompiler",
            "rggen",
        ],
        "policy": {
            "imports_external_ip": False,
            "downloads_ip": False,
            "runs_generator": False,
            "runs_eda_flow": False,
            "changes_platform_contract": False,
            "changes_register_map": False,
            "changes_rtl": False,
            "changes_headers": False,
            "changes_device_tree": False,
            "changes_driver": False,
            "generates_rtl": False,
            "generates_headers": False,
            "generates_docs": False,
            "generates_ipxact": False,
            "generates_systemrdl": False,
            "runs_llm": False,
            "prediction_generated": False,
            "ip_quality_claim_allowed": False,
            "register_correctness_claim_allowed": False,
            "platform_contract_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "single-source-register-contract-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future SystemRDL, IP-XACT, OpenTitan reggen, or RgGen adoption must keep E1 platform contracts, RTL offsets, generated headers, docs, and drivers synchronized",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make platform-contract-check",
                    "make npu-runtime-contract-check",
                    "make docs-check",
                ],
            },
            {
                "id": "external-ip-manifest-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future FuseSoC, Edalize, Bender, SiliconCompiler, or IP-XACT IP intake must pin revisions, licenses, file manifests, bus interfaces, reset/clock domains, and local gates",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
                    "make no-hardware-action-check",
                    "make rtl-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "ai-register-map-review-watch",
                "status": "CAPTURED_NOT_APPLIED",
                "target": "future AI suggestions for MMIO regions, CSR fields, interrupts, headers, or device-tree bindings must be converted to reviewed contract diffs before generators run",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation",
                    "make platform-contract-check",
                    "make memory-interconnect-contract-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "software-visible-abi-drift-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future generated platform artifacts must prove Linux, Buildroot, AOSP, boot ROM, NPU runtime, and RTL register views remain ABI-compatible",
                "acceptance_gates": [
                    "python3 scripts/check_linux_platform_contract.py",
                    "make software-contract-check",
                    "make buildroot-check",
                    "make aosp-bsp-check",
                    "make npu-2028-target-check",
                ],
            },
        ],
        "blocked_by": [
            "no approved SystemRDL, IP-XACT, Hjson, or RgGen source-of-truth selected for E1 register maps",
            "no migration policy from sw/platform/e1_platform_contract.json to an external register/IP generator",
            "no license-reviewed external IP dependency manifest with revisions, file hashes, bus interfaces, reset domains, and clock domains",
            "no AI-to-contract review workflow for generated register fields, memory-map regions, interrupts, DT bindings, headers, or driver ABI changes",
            "no local proof that generated register RTL, headers, docs, UVM/RAL, and software bindings remain synchronized with E1 RTL",
            "no release gate allowing generated IP/register collateral to bypass platform, Linux, RTL, cocotb, synthesis, and review gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.ip_register_contract.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
