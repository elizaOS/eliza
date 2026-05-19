#!/usr/bin/env python3
"""Capture dry-run analog/mixed-signal AI/EDA targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/analog_mixed_signal_targets"
CLAIM_BOUNDARY = "analog_mixed_signal_target_capture_only_no_spice_layout_or_ip_generation"

INPUT_ARTIFACTS = (
    "docs/pd/pad-cell-selection-criteria.md",
    "pd/padframe/e1_demo_padframe.yaml",
    "package/e1-demo-pinout.yaml",
    "package/wifi-external-interface.yaml",
    "pd/signoff/si-pi/local-evidence.yaml",
    "docs/project/board-package-pd-fpga-critical-gap-audit.md",
    "docs/spec-db/process-14a-effects.yaml",
    "docs/manufacturing/board-package-2028-scaling-checklist.yaml",
)

OPTIONAL_COMMANDS = (
    "ngspice",
    "xschem",
    "magic",
    "netgen",
    "klayout",
    "openroad",
)

OPTIONAL_PYTHON_MODULES = (
    "align",
    "gym",
    "torch",
    "skopt",
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


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
        "schema": "eliza.ai_eda.analog_mixed_signal_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_ANALOG_GENERATION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "align-analoglayout",
            "autockt",
            "genie-asi",
            "acdc-analog-llm",
            "ado-llm",
            "analoggenie",
            "masala-chai",
            "limca",
        ],
        "policy": {
            "generates_spice_netlist": False,
            "generates_layout": False,
            "runs_spice": False,
            "runs_drc_lvs": False,
            "selects_foundry_ip": False,
            "changes_padframe": False,
            "release_use_allowed": False,
            "human_analog_review_required": True,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "pad-esd-library-selection-review",
                "status": "CAPTURED_NOT_AUTOMATED",
                "target": "rank open IO/pad/ESD library candidates against local pad criteria",
                "acceptance_gates": [
                    "make padframe-check",
                    "make board-package-evidence-check",
                ],
            },
            {
                "id": "si-pi-gap-triage",
                "status": "CAPTURED_NOT_SIMULATED",
                "target": "triage missing IBIS, SPICE, S-parameter, rail impedance, and current evidence",
                "acceptance_gates": [
                    "make power-thermal-evidence-check",
                    "make board-package-evidence-check",
                ],
            },
            {
                "id": "wifi-module-io-sequencing-review",
                "status": "CAPTURED_NOT_BOUND_TO_RTL",
                "target": "review external Wi-Fi module voltage, reset, regulator, and SDIO constraints",
                "acceptance_gates": [
                    "python3 scripts/check_wifi_interface.py",
                    "make board-package-evidence-check",
                ],
            },
            {
                "id": "analog-imc-research-watch",
                "status": "RESEARCH_ONLY",
                "target": "track analog IMC netlist-generation research without E1 source integration",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                ],
            },
        ],
        "blocked_by": [
            "no local analog SPICE specs or testbenches for E1",
            "no foundry pad library selected or released",
            "no IBIS, S-parameter, package parasitic, or rail impedance model",
            "no approved flow for AI-generated SPICE, analog layout, or foundry IP",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.analog_mixed_signal.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
