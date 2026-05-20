#!/usr/bin/env python3
"""Capture dry-run memory macro, SRAM compiler, and library automation targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/memory_macro_library_targets"
CLAIM_BOUNDARY = "memory_macro_library_capture_only_no_macro_generation_or_library_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "pd/macros/manifest.yaml",
    "pd/macros/sky130/README.md",
    "pd/macros/sky130/e1_sram_4kb_1rw/e1_sram_4kb_1rw.openram.config.py",
    "pd/macros/sky130/e1_sram_16kb_1rw/e1_sram_16kb_1rw.openram.config.py",
    "pd/macros/sky130/e1_sram_64kb_1rw/e1_sram_64kb_1rw.openram.config.py",
    "pd/macros/ihp-sg13g2/README.md",
    "pd/macros/ihp-sg13g2/e1_sram_4kb_1rw_sg13g2/e1_sram_4kb_1rw_sg13g2.compiler.yaml",
    "pd/macros/ihp-sg13g2/e1_sram_16kb_1rw_sg13g2/e1_sram_16kb_1rw_sg13g2.compiler.yaml",
    "pd/library-manifests/sky130.yaml",
    "pd/library-manifests/ihp-sg13g2.yaml",
    "pd/library-manifests/asap7.yaml",
    "pd/library-manifests/intel-14a.yaml",
    "pd/corner-manifests/sky130.yaml",
    "pd/corner-manifests/ihp-sg13g2.yaml",
    "pd/corner-manifests/asap7.yaml",
    "pd/corner-manifests/intel-14a.yaml",
    "pd/openlane/config.sky130.json",
    "pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v",
    "rtl/memory/e1_weight_buffer_sram.sv",
    "rtl/cache/l1d/e1_l1d_cache.sv",
    "docs/evidence/process/pdk-access-gate.yaml",
    "docs/evidence/process/pdk-portability.json",
    "docs/evidence/process/ppa-projection.yaml",
    "docs/evidence/memory/uma-dram-evidence-gate.yaml",
    "docs/evidence/memory/axi4-burst-evidence-gate.yaml",
    "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json",
    "scripts/check_pdk_portability.py",
    "scripts/check_memory_uma_claim_gate.py",
    "scripts/check_memory_evidence_templates.py",
    "scripts/check_memory_interconnect_contract.py",
    "scripts/check_process_14a_effects.py",
    "scripts/check_pd_signoff.py",
    "scripts/check_openlane_run_preflight.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "openram",
    "openroad",
    "yosys",
    "magic",
    "netgen",
    "klayout",
    "cacti",
    "destiny",
    "nvsim",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "openram",
    "numpy",
    "scipy",
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
        "schema": "eliza.ai_eda.memory_macro_library_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_MEMORY_MACRO_LIBRARY_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openram",
            "dffram",
            "openxram",
            "openrram",
            "cacti",
            "destiny-memory-model",
            "nvsim",
            "neurosim",
            "openacm-cim",
            "openacmv2-cim",
            "opencellgen-stdcell",
            "topcell-llm-stdcell",
            "cpcell-stdcell-dtco",
            "charlib-stdcell-characterization",
            "nvcell-stdcell-rl",
            "sram-compiler-openroad",
            "sram-yield-estimation",
            "openyield-sram",
        ],
        "policy": {
            "downloads_pdk_or_macros": False,
            "imports_external_macro": False,
            "runs_memory_compiler": False,
            "runs_memory_estimator": False,
            "runs_ai_model": False,
            "runs_openlane": False,
            "runs_openroad": False,
            "runs_drc_lvs_extraction": False,
            "changes_rtl": False,
            "changes_pd_config": False,
            "changes_liberty": False,
            "changes_lef": False,
            "changes_gds": False,
            "generates_macro": False,
            "generates_memory_model": False,
            "generates_bist_or_repair": False,
            "prediction_generated": False,
            "area_timing_power_claim_allowed": False,
            "vmin_yield_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "open-sram-compiler-readiness-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future OpenRAM, DFFRAM, OpenXRAM, OpenRRAM, or OpenROAD SRAM/memory compiler use must pin compiler revisions, PDK/device revisions, configs, macro names, ports, timing corners, and generated artifact hashes",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make pdk-portability-check",
                    "make memory-evidence-template-check",
                    "make openlane-run-preflight-check",
                ],
            },
            {
                "id": "memory-estimator-advisory-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future CACTI, DESTINY, NVSim, or NeuroSim estimates may guide exploration only after E1 cache/SRAM parameters, process assumptions, and calibration gaps are recorded",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation",
                    "make memory-uma-claim-gate",
                    "make memory-interconnect-contract-check",
                    "make process-14a-effects-check",
                ],
            },
            {
                "id": "macro-integration-signoff-watch",
                "status": "CAPTURED_NOT_INTEGRATED",
                "target": "future SRAM macro swaps must prove RTL wrappers, Liberty, LEF, GDS, antenna, PDN, DRC/LVS, STA, synthesis, and OpenLane manifests are synchronized",
                "acceptance_gates": [
                    "make pd-signoff-manifest-check",
                    "make rtl-check",
                    "make synth",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "sram-yield-vmin-repair-watch",
                "status": "CAPTURED_NOT_CLAIMED",
                "target": "future AI-assisted SRAM yield, Vmin, redundancy, ECC, BIST, repair, or OpenYield-style benchmark suggestions must remain advisory until backed by foundry/process models and deterministic E1 tests",
                "acceptance_gates": [
                    "make power-thermal-evidence-check",
                    "make memory-interconnect-contract-check",
                    "make process-14a-effects-check",
                    "make docs-check",
                ],
            },
            {
                "id": "sram-cim-compiler-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future OpenACM/OpenACMv2-style SRAM compute-in-memory compiler or co-optimization use requires architecture, accuracy, process, generated-collateral, PVT/variation, and workload replay gates before any E1 NPU or memory change",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "make memory-interconnect-contract-check",
                    "make pdk-portability-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "standard-cell-generation-characterization-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future AutoCellGen, TOPCELL, CPCell, CharLib, or NVCell-style standard-cell generation and characterization requires PDK authority, generated GDS/LEF/Liberty/SPICE hashes, DRC/LVS/extraction, PVT characterization logs, STA, synthesis, OpenLane replay, licensing, and review",
                "acceptance_gates": [
                    "make pdk-portability-check",
                    "make synth",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                ],
            },
        ],
        "blocked_by": [
            "no approved external memory compiler revision, PDK setup, or generated SRAM macro manifest for E1 release use",
            "no local DRC, LVS, extraction, Liberty, LEF, GDS, antenna, STA, and OpenLane run evidence for generated or swapped SRAM macros",
            "no technology-calibrated CACTI, DESTINY, NVSim, NeuroSim, or AI estimator correlation against E1 macro layouts and corners",
            "no approved OpenXRAM/OpenRRAM/OpenACM revision, PDK/device model, generated collateral quarantine, workload accuracy replay, or signoff mapping",
            "no approved standard-cell generation or characterization flow with PDK authority, DRC/LVS/extraction, Liberty, STA, synthesis, OpenLane, and block-level replay evidence",
            "no foundry-approved SRAM yield, Vmin, redundancy, BIST, repair, or aging model",
            "no OpenYield process/model compatibility review, train/test split, Monte Carlo replay, or local macro-test evidence",
            "no release policy allowing AI-selected memory macros or library corners to bypass PDK, memory, RTL, synthesis, PD, and review gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.memory_macro_library.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
