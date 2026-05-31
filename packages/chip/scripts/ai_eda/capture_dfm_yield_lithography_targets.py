#!/usr/bin/env python3
"""Capture dry-run DFM, yield, lithography, and OPC AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/dfm_yield_lithography_targets"
CLAIM_BOUNDARY = "dfm_yield_lithography_target_capture_only_no_mask_yield_or_release_claim"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "training_claim_allowed": False,
    "inference_claim_allowed": False,
    "e1_optimization_claim_allowed": False,
    "e1_signoff_claim_allowed": False,
    "ppa_signoff_claim_allowed": False,
}

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "pd/openlane/config.json",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/signoff/README.md",
    "pd/signoff-evidence-template.md",
    "docs/manufacturing/release-manifest.yaml",
    "docs/manufacturing/release-evidence-template.md",
    "docs/manufacturing/physical-closure-work-order.yaml",
    "docs/manufacturing/real-world-verification-gaps.yaml",
    "docs/project/critical-gap-review.md",
    "docs/project/board-package-pd-fpga-critical-gap-audit.md",
    "docs/pd/e1_chip_top_antenna_metadata_2026-05-18.md",
    "scripts/check_pd_signoff.py",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_antenna_metadata.py",
    "scripts/check_manufacturing_artifacts.py",
    "scripts/check_real_world_gates.py",
    "build/ai_eda/pd_predictor_dataset/validation/snapshot_manifest.json",
    "build/reports/e1_soc_yosys.log",
    "build/reports/formal_manifest.json",
)

OPTIONAL_COMMANDS = (
    "klayout",
    "magic",
    "netgen",
    "openroad",
    "yosys",
    "python3",
    "git",
)

OPTIONAL_PYTHON_MODULES = (
    "gdstk",
    "gdspy",
    "shapely",
    "sklearn",
    "torch",
    "torchvision",
    "cv2",
    "yaml",
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
        "schema": "eliza.ai_eda.dfm_yield_lithography_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_DFM_YIELD_LITHOGRAPHY_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "source_ids": [
            "agentictcad",
            "tcadgpt",
            "litho-aware-ml-hotspot",
            "dlhsd-hotspot-detection",
            "lithohod",
            "torchlitho",
            "openilt",
            "diffopc",
            "radai-wm811k-wafer-defect-model",
            "pegasus-lpa",
        ],
        "policy": {
            "changes_layout": False,
            "changes_masks": False,
            "changes_constraints": False,
            "changes_opc": False,
            "changes_pdk_rules": False,
            "generates_layout": False,
            "generates_mask": False,
            "generates_hotspot_labels": False,
            "runs_lithography_sim": False,
            "runs_opc": False,
            "runs_drc": False,
            "runs_lvs": False,
            "runs_ml_model": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "imports_foundry_data": False,
            "prediction_generated": False,
            "dfm_claim_allowed": False,
            "yield_claim_allowed": False,
            "mask_claim_allowed": False,
            "wafer_defect_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "lithography-hotspot-screening-watch",
                "status": "CAPTURED_NOT_SCREENED",
                "target": "future hotspot detection must use layout clips tied to exact GDS/DEF, layer maps, process decks, labels, and foundry-approved DFM rules",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make pd-contract-check",
                    "make manufacturing-artifacts-check",
                ],
            },
            {
                "id": "differentiable-lithography-opc-watch",
                "status": "CAPTURED_NOT_OPTIMIZED",
                "target": "future TorchLitho, OpenILT, or DiffOPC-style experiments must stay outside release until exact masks, kernels, process conditions, and EPE/PVBand metrics are reviewed",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "make pd-contract-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "yield-wafer-defect-model-watch",
                "status": "CAPTURED_NOT_CLASSIFIED",
                "target": "future wafer-map or AOI models must only classify E1-specific measured artifacts with lot, wafer, board, camera, and annotation provenance",
                "acceptance_gates": [
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                    "make product-check",
                ],
            },
            {
                "id": "tcad-dtco-device-optimization-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future TCAD/DTCO agents must stay outside release until TCAD decks, simulator licenses, process authority, calibration data, raw logs, and human process-device review exist",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make process-14a-effects-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "physical-signoff-feature-corpus-watch",
                "status": "CAPTURED_NOT_EXPORTED",
                "target": "future DFM or yield predictors need signoff feature manifests with DRC, LVS, antenna, density, fill, congestion, STA, EM, and waiver hashes",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id validation",
                    "make synth",
                    "make pd-contract-check",
                ],
            },
            {
                "id": "manufacturing-release-blocker-watch",
                "status": "CAPTURED_NOT_RELEASED",
                "target": "future AI-assisted DFM fixes must be promoted only through physical closure, manufacturing, real-world, and human review gates",
                "acceptance_gates": [
                    "make docs-check",
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no E1 final GDS, routed DEF, fill, density, DRC, LVS, antenna, EM, OPC, mask, or lithography simulation evidence",
            "no foundry-approved rule deck, layer map, lithography kernel, resist model, focus/dose process window, or DFM hotspot labels",
            "no license-reviewed ICCAD, foundry, wafer-map, AOI, or E1 manufacturing dataset selected for local training or evaluation",
            "no local held-out E1 layout clips with human-reviewed hotspot, false-positive, or repair labels",
            "no wafer, lot, die, board, camera, SEM, inspection, or first-article measurement corpus for yield or defect models",
            "no approved TCAD deck, commercial TCAD license, open TCAD backend, device calibration data, or foundry-authorized process/device authority for E1",
            "no approved flow for AI-generated layout, mask, OPC, DFM fixes, yield prediction, or signoff waivers",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.dfm_yield_lithography.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
