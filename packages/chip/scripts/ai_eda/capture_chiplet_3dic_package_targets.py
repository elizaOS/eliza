#!/usr/bin/env python3
"""Capture dry-run chiplet, 2.5D/3DIC, and advanced-package AI targets."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/chiplet_3dic_package_targets"
CLAIM_BOUNDARY = "chiplet_3dic_package_capture_only_no_package_or_architecture_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "package/e1-demo-pinout.yaml",
    "package/artifact-manifest.yaml",
    "package/bonding/e1_demo_bonding.csv",
    "pd/padframe/e1_demo_padframe.yaml",
    "docs/package/e1-demo-package.md",
    "docs/package/e1-demo-pad-ring.md",
    "docs/package/bonding-diagram-template.md",
    "docs/manufacturing/board-package-2028-scaling-checklist.yaml",
    "docs/manufacturing/board-package-evidence.yaml",
    "docs/manufacturing/physical-closure-work-order.yaml",
    "docs/manufacturing/real-world-verification-gaps.yaml",
    "docs/manufacturing/product-package-board-pd-blockers-2026-05-17.md",
    "docs/manufacturing/evidence/board/e1-demo-package-padframe-board-cross-probe-draft.yaml",
    "docs/manufacturing/evidence/board/e1-demo-si-pi-local-draft.md",
    "docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md",
    "docs/evidence/memory/lpddr-phy-procurement.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/evidence/process/pdk-access-gate.yaml",
    "docs/evidence/pd/commercial-eda-gate.yaml",
    "docs/pd/signoff/si-pi/local-gap-report.md",
    "scripts/check_package_cross_probe.py",
    "scripts/check_board_package_evidence.py",
    "scripts/check_manufacturing_artifacts.py",
    "scripts/check_real_world_gates.py",
    "scripts/check_padframe_contract.py",
    "scripts/check_power_thermal_evidence.py",
    "scripts/check_memory_interconnect_contract.py",
    "scripts/check_pd_signoff.py",
    "scripts/check_no_hardware_actions.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "kicad-cli",
    "openroad",
    "klayout",
    "magic",
    "netgen",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "networkx",
    "numpy",
    "scipy",
    "sklearn",
    "torch",
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
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.chiplet_3dic_package_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_CHIPLET_3DIC_PACKAGE_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "tap-2p5d",
            "rapidchiplet",
            "placeit-chiplet-topology",
            "diffchip-chiplet-placement",
            "tdpnavigator-placer",
            "chipletpart",
            "chiplet-network-sim",
            "legosim-chiplet-simulator",
            "hisim-heterogeneous-integration",
            "mfit-chiplet-thermal",
            "threed-ice-4-thermal",
            "eco-chip",
            "ucie-standard",
            "chipsalliance-cde",
            "mahl-chiplet",
            "chico-agent",
            "ds2sc-agent",
        ],
        "policy": {
            "changes_architecture": False,
            "changes_package": False,
            "changes_pinout": False,
            "changes_padframe": False,
            "changes_board": False,
            "changes_rtl": False,
            "changes_pd_config": False,
            "generates_chiplet_partition": False,
            "generates_interposer_layout": False,
            "generates_ucie_or_die_to_die_interface": False,
            "generates_package_or_bump_map": False,
            "generates_si_pi_thermal_model": False,
            "runs_eda_flow": False,
            "runs_external_simulator": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "cost_yield_perf_claim_allowed": False,
            "package_release_claim_allowed": False,
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
                "id": "chiplet-partition-topology-watch",
                "status": "CAPTURED_NOT_PARTITIONED",
                "target": "future chiplet partitioning, topology, interposer, bridge, or die-to-die suggestions must remain outside E1 architecture until package, memory, power, and software contracts are reviewed",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make package-cross-probe-check",
                    "make memory-interconnect-contract-check",
                    "make platform-contract-check",
                ],
            },
            {
                "id": "rapid-chiplet-dse-watch",
                "status": "CAPTURED_NOT_EXPLORED",
                "target": "future RapidChiplet, PlaceIT, DiffChip, or TDPNavigator-style DSE must remain advisory until package stack, power maps, traffic manifests, PHY assumptions, reward definitions, output hashes, and local replay evidence are reviewed",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make package-cross-probe-check",
                    "make power-thermal-evidence-check",
                    "make board-package-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "ucie-die-to-die-interface-watch",
                "status": "CAPTURED_NOT_INTEGRATED",
                "target": "future UCIe or die-to-die interface work must prove protocol, PHY, bump map, clock/reset, firmware, Linux, and verification contracts before source changes",
                "acceptance_gates": [
                    "make padframe-check",
                    "make platform-contract-check",
                    "make rtl-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "package-si-pi-thermal-codesign-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future MFIT, 3D-ICE, or package co-design use must tie power maps, thermal models, PDN, SI/PI, die stacking, and board constraints to local evidence",
                "acceptance_gates": [
                    "make power-thermal-evidence-check",
                    "make pd-signoff-manifest-check",
                    "make board-package-evidence-check",
                    "make package-cross-probe-check",
                ],
            },
            {
                "id": "heterogeneous-integration-simulator-watch",
                "status": "CAPTURED_NOT_SIMULATED",
                "target": "future LEGOSim or HISIM-style heterogeneous-integration simulation must remain advisory until chiplet partition, package stack, traffic traces, die-to-die assumptions, simulator revisions, and replay logs are reviewed",
                "acceptance_gates": [
                    "make memory-interconnect-contract-check",
                    "make package-cross-probe-check",
                    "make power-thermal-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "manufacturing-cost-yield-watch",
                "status": "CAPTURED_NOT_CLAIMED",
                "target": "future chiplet cost, yield, known-good-die, test, repair, or supply-chain claims require vendor/process evidence and deterministic release gates",
                "acceptance_gates": [
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
        ],
        "blocked_by": [
            "no selected E1 chiplet architecture, die partition, interposer, bridge, organic substrate, bump map, or die-to-die PHY",
            "no UCIe or other die-to-die RTL, PHY collateral, verification suite, firmware contract, Linux contract, or package pin/bump evidence",
            "no package vendor stack-up, SI/PI extraction, thermal stack, warpage, assembly, known-good-die, or yield evidence",
            "no license-reviewed external chiplet/package simulator, placement, topology, or LLM-agent implementation with pinned revisions and local replay",
            "no approved LEGOSim, HISIM, MFIT, or 3D-ICE setup with pinned revisions, package stack/material assumptions, power maps, traffic traces, die-to-die PHY assumptions, simulator logs, calibration, and reviewer disposition",
            "no approved RapidChiplet, PlaceIT, DiffChip, or TDPNavigator-style flow with pinned revisions/assets, package stack, power maps, traffic manifests, PHY assumptions, rewards/seeds where applicable, output hashes, thermal/SI/PI evidence, and reviewer disposition",
            "no release gate allowing AI-generated chiplet partitioning, package changes, interposer routing, or die-to-die interfaces to bypass architecture, RTL, PD, software, package, manufacturing, and review gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.chiplet_3dic_package.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
