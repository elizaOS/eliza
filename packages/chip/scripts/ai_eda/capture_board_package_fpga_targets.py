#!/usr/bin/env python3
"""Capture dry-run board, package, manufacturing, and FPGA AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/board_package_fpga_targets"
CLAIM_BOUNDARY = "board_package_fpga_target_capture_only_no_fab_package_or_fpga_claim"

INPUT_ARTIFACTS = (
    "package/e1-demo-pinout.yaml",
    "package/artifact-manifest.yaml",
    "package/wifi-external-interface.yaml",
    "package/wifi/evidence-gates.yaml",
    "package/scripts/validate_pinout.py",
    "package/scripts/validate_pinout_vs_rtl.py",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-demo/e1-demo.kicad_pro",
    "board/kicad/e1-demo/e1-demo.kicad_sch",
    "board/kicad/e1-demo/e1-demo.kicad_pcb",
    "board/fpga/artifact-manifest.yaml",
    "board/fpga/release_manifest.yaml",
    "board/fpga/e1_demo_fpga.yaml",
    "board/fpga/constraints/e1_demo_ulx3s.lpf",
    "docs/manufacturing/board-package-2028-scaling-checklist.yaml",
    "docs/manufacturing/board-package-evidence.yaml",
    "docs/manufacturing/release-manifest.yaml",
    "docs/manufacturing/evidence/board/e1-demo-local-dfm-draft.md",
    "docs/manufacturing/evidence/board/e1-demo-si-pi-local-draft.md",
    "docs/manufacturing/evidence/board/e1-demo-package-padframe-board-cross-probe-draft.yaml",
    "docs/manufacturing/schemas/board-fab-evidence.schema.yaml",
    "scripts/check_board_package_evidence.py",
    "scripts/check_package_cross_probe.py",
    "scripts/check_kicad_artifacts.py",
    "scripts/check_fpga_release.py",
    "scripts/check_fpga_target.py",
    "scripts/check_wifi_interface.py",
    "scripts/check_antenna_metadata.py",
    "scripts/check_manufacturing_artifacts.py",
    "scripts/check_real_world_gates.py",
)

OPTIONAL_COMMANDS = (
    "kicad-cli",
    "freerouting",
    "yosys",
    "nextpnr-ecp5",
    "ecppack",
    "openocd",
    "sigrok-cli",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "jsonschema",
    "networkx",
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
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.board_package_fpga_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_BOARD_PACKAGE_FPGA_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "pcbschemagen",
            "omnisch",
            "circuitron-pcb-agent",
            "pcb-bench",
            "pcbagent",
            "neurpcb",
            "pcb-migrator",
            "mars-place-pcb",
            "pcb-pr-app",
            "freerouting",
            "dreamerv3-fr-pcb",
            "pcb-3d-lineexplore",
            "dreamplacefpga",
            "openparf-fpga-placement",
            "rapidwright-dreamplacefpga",
            "vtr-fpga-cad-flow",
            "openfpga-fabric-generator",
            "fabulous-efpga-framework",
            "deeppcb-defect-dataset",
            "circuit-weaver",
            "kicad-mcp-pro",
            "kicad-si-wrapper",
            "open-schematics-kicad",
            "gerberformer-pcb-defect",
        ],
        "policy": {
            "changes_board": False,
            "changes_package": False,
            "changes_pinout": False,
            "changes_fpga": False,
            "generates_schematic": False,
            "generates_pcb": False,
            "routes_board": False,
            "generates_gerbers": False,
            "runs_kicad_cli": False,
            "runs_fpga_flow": False,
            "runs_llm": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "board_fab_claim_allowed": False,
            "package_release_claim_allowed": False,
            "fpga_release_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "pinout-package-board-cross-probe",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "keep package pinout, padframe, RTL ports, and KiCad net names cross-probed before any AI placement or schematic suggestion is considered",
                "acceptance_gates": [
                    "make pinout-check",
                    "make package-cross-probe-check",
                    "make padframe-check",
                ],
            },
            {
                "id": "kicad-fab-evidence-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future PCB schematic/layout suggestions from PCBSchemaGen, Circuitron, PCB placement agents, or multimodal schematic benchmarks must remain outside source until KiCad ERC, DRC, fabrication outputs, BOM, position files, package cross-probe, and DFM/SI/PI evidence pass",
                "acceptance_gates": [
                    "make kicad-artifact-check",
                    "make board-package-evidence-check",
                    "make manufacturing-artifacts-check",
                ],
            },
            {
                "id": "pcb-router-policy-watch",
                "status": "CAPTURED_NOT_ROUTED",
                "target": "future FreeRouting, DreamerV3+FR, 3D LineExplore, MARS-Place, or other PCB routing/placement outputs must stay quarantined until board-rule hashes, input/output KiCad hashes, ERC/DRC, route reports, SI/PI, DFM, and human review pass",
                "acceptance_gates": [
                    "make kicad-artifact-check",
                    "make board-package-evidence-check",
                    "make manufacturing-artifacts-check",
                ],
            },
            {
                "id": "fpga-prototype-flow-watch",
                "status": "CAPTURED_NOT_BUILT",
                "target": "future DREAMPlaceFPGA, OpenPARF, RapidWright, VTR, OpenFPGA, FABulous, or other FPGA placement, CAD, fabric-generation, routing, or bitstream optimization must preserve exact board revision, device/fabric architecture, constraints, tool versions, output hashes, timing evidence, and bring-up evidence",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make fpga-check",
                    "make fpga-release-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "wifi-rf-regulatory-watch",
                "status": "CAPTURED_NOT_CERTIFIED",
                "target": "block AI-assisted Wi-Fi, RF, antenna, shielding, and keepout changes until module evidence and regulatory blockers are closed",
                "acceptance_gates": [
                    "make wifi-interface-check",
                    "make antenna-metadata-check",
                ],
            },
            {
                "id": "manufacturing-release-evidence-watch",
                "status": "CAPTURED_NOT_RELEASED",
                "target": "future board/package/FPGA automation must be promoted only through manufacturing and real-world release gates",
                "acceptance_gates": [
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                    "make product-check",
                ],
            },
            {
                "id": "kicad-agent-and-mcp-tool-watch",
                "status": "CAPTURED_NOT_CONNECTED",
                "target": "future Circuit Weaver or KiCad MCP Pro style agent tooling must pin package/source revisions, dependency and model/provider manifests, MCP command schemas, tool allowlists, prompt/output hashes, generated-output quarantine, KiCad ERC/DRC/DFM/SI/PI logs, and human disposition before any write-capable use",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make kicad-artifact-check",
                    "make package-cross-probe-check",
                    "make board-package-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "board-si-simulation-preprocessor-watch",
                "status": "CAPTURED_NOT_SIMULATED",
                "target": "future KiCad SI wrapper or OpenEMS-style board simulation preprocessing requires exact tool revisions, board/stackup/net/port hashes, generated slice hashes, simulator logs, SI/PI comparison evidence, and reviewer disposition",
                "acceptance_gates": [
                    "make board-package-evidence-check",
                    "make package-cross-probe-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "schematic-and-aoi-corpus-intake-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future Open Schematics or GerberFormer-style datasets/models require exact revisions, licenses, split and non-overlap review, E1 artifact overlap checks, generated-output quarantine, held-out board/image error analysis, and manufacturing reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make manufacturing-artifacts-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no vendor package drawing, footprint, bonding diagram, IBIS/electrical model, or reviewed package vendor evidence",
            "no release-clean KiCad ERC, DRC, Gerber, drill, BOM, position, DFM, SI, or PI evidence for AI-modified board artifacts",
            "no exact FPGA board revision, device/fabric architecture manifest, routed constraints, timing-clean bitstream, or hardware bring-up transcript for AI-assisted FPGA optimization",
            "no antenna, shielding, SAR, modular approval, or regional regulatory evidence for Wi-Fi/RF release claims",
            "no license-reviewed multimodal schematic benchmark snapshot, E1 image/prompt non-overlap report, or KiCad follow-up workflow",
            "no approved agentic KiCad generation workflow with dependency pins, prompt/output quarantine, ERC/DRC/fab logs, and human review",
            "no approved PCB routing policy or route-output quarantine for world-model RL, geometric routing, or FreeRouting-backed experiments",
            "no approved Circuit Weaver or KiCad MCP Pro agent-tooling flow with pinned command schemas, tool allowlists, model/provider manifests, generated-output quarantine, and KiCad evidence",
            "no approved KiCad SI wrapper or OpenEMS preprocessing flow with board stackup, selected-net, port, generated-slice, simulator, and SI/PI comparison evidence",
            "no license-reviewed Open Schematics, GerberFormer, or other PCB schematic/AOI model corpus with exact snapshot, split/non-overlap review, E1 artifact overlap checks, local board images, and reviewer disposition",
            "no approved workflow for AI-generated schematics, PCB placement, routing, pinout, package, or FPGA artifacts",
            "no license-reviewed PCB/FPGA automation implementation path selected for E1",
            "no approved OpenPARF, VTR, OpenFPGA, FABulous, RapidWright, or DREAMPlaceFPGA flow with pinned revisions, device/fabric constraints, generated-output quarantine, flow logs, timing evidence, bitstream hashes, and bring-up review",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.board_package_fpga.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
