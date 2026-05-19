#!/usr/bin/env python3
"""Capture dry-run power, thermal, IR-drop, and PDN AI/EDA targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/power_thermal_targets"
CLAIM_BOUNDARY = "power_thermal_target_capture_only_no_power_or_thermal_claim"

INPUT_ARTIFACTS = (
    "benchmarks/power/workload-plan.yaml",
    "benchmarks/power/manifests/e1-npu-sustained-capture.template.json",
    "benchmarks/power/sustained-run-evidence.schema.json",
    "benchmarks/power/scripts/check_sustained_run_evidence.py",
    "benchmarks/power/scripts/derive_local_power_estimates.py",
    "docs/manufacturing/evidence/power/e1-npu-power-capture-manifest.yaml",
    "docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md",
    "benchmarks/configs/benchmark_plan.json",
    "benchmarks/results/soc-optimized-operating-point.json",
    "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json",
    "pd/signoff/si-pi/local-evidence.yaml",
    "pd/signoff/manifest.yaml",
    "pd/openlane/config.sky130.json",
    "docs/spec-db/process-14a-effects.yaml",
    "docs/manufacturing/board-package-2028-scaling-checklist.yaml",
    "scripts/check_cpu_npu_burst_sustained_policy.py",
    "scripts/check_cpu_npu_burst_thermal_transient.py",
)

OPTIONAL_COMMANDS = (
    "openroad",
    "klayout",
    "magic",
    "ngspice",
    "hotspot",
    "mcpat",
)

OPTIONAL_PYTHON_MODULES = (
    "torch",
    "numpy",
    "scipy",
    "sklearn",
    "cv2",
    "matplotlib",
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
        "schema": "eliza.ai_eda.power_thermal_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_POWER_THERMAL_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "deepoheat",
            "thermal-generative-ai",
            "thermedge-iredge",
            "waca-unet-ir-drop",
            "ir-drop-predictor",
            "eda-irdrop-prediction",
            "openpdn",
            "aieda",
            "rtlmul",
        ],
        "policy": {
            "generates_power_map": False,
            "generates_thermal_map": False,
            "generates_pdn": False,
            "changes_pdn": False,
            "changes_floorplan": False,
            "runs_power_analysis": False,
            "runs_thermal_analysis": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "release_use_allowed": False,
            "tops_per_w_claim_allowed": False,
            "thermal_claim_allowed": False,
            "ir_drop_claim_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "power-thermal-label-readiness",
                "status": "CAPTURED_NOT_MODELED",
                "target": "hash sustained power, thermal, frequency, workload, and calibration evidence contracts",
                "acceptance_gates": [
                    "make power-thermal-evidence-check",
                    "make power-thermal-evidence-test",
                ],
            },
            {
                "id": "ir-drop-pdn-predictor-watch",
                "status": "CAPTURED_NOT_PREDICTED",
                "target": "future static/dynamic IR-drop and PDN template predictor after local OpenROAD/PDNSim labels exist",
                "acceptance_gates": [
                    "make pd-signoff-manifest-check",
                    "make physical-closure-work-order-check",
                ],
            },
            {
                "id": "thermal-hotspot-surrogate-watch",
                "status": "CAPTURED_NOT_PREDICTED",
                "target": "future thermal surrogate screening after power maps, package model, and measured traces exist",
                "acceptance_gates": [
                    "make power-thermal-evidence-check",
                    "make board-package-evidence-check",
                ],
            },
            {
                "id": "rtl-ppa-power-advisory-join",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "join RTLMUL-style RTL power priors with local post-route and measured power labels only after calibration",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/run_rtlmul_ppa_advisory.py --run-id validation",
                    "make synth",
                ],
            },
        ],
        "blocked_by": [
            "no calibrated E1 rail power trace, thermal trace, frequency trace, or workload transcript",
            "no package, board, airflow, heatsink, or phone skin thermal model calibrated to E1",
            "no local OpenROAD/PDNSim IR-drop label corpus across repeated runs",
            "no activity-aligned power map or vector-based post-route power evidence",
            "no approved flow for AI-generated PDN, power map, thermal map, or signoff waiver",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.power_thermal.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
