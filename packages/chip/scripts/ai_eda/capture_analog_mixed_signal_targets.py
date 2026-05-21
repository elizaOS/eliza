#!/usr/bin/env python3
"""Capture dry-run analog/mixed-signal AI/EDA targets for E1."""

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
    "Xyce",
    "openvaf",
    "xschem",
    "magic",
    "netgen",
    "klayout",
    "openroad",
)

OPTIONAL_PYTHON_MODULES = (
    "PySpice",
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
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.analog_mixed_signal_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_ANALOG_GENERATION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "align-analoglayout",
            "bag3-analog-generator",
            "openfasoc-generators",
            "laygo2",
            "magical-analog-layout",
            "autockt",
            "genie-asi",
            "acdc-analog-llm",
            "ado-llm",
            "analoggenie",
            "masala-chai",
            "limca",
            "analogagent",
            "autosizer-ams",
            "easysize",
            "self-calibrating-analog-equations",
            "ngspice",
            "pyspice",
            "xyce",
            "openvaf",
            "eesizer",
            "analogmaster",
            "vlm-cad",
            "circuitlm",
            "eeschematic",
            "analogcoder-pro",
            "analogcoder",
            "ams-net",
            "analog-layout-vlm-dataset",
            "analog-circuits-sky130",
            "spicepilot",
            "analogseeker",
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
                "id": "analog-agent-spice-loop-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future analog LLM/agent sizing or topology loops must stay quarantined until exact prompts, model versions, memory/search traces, SPICE decks, simulator logs, PVT sweeps, generated dimension quarantine, and analog review exist",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make padframe-check",
                    "make board-package-evidence-check",
                ],
            },
            {
                "id": "deterministic-analog-generator-backend-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future BAG3++/OpenFASOC/laygo2/MAGICAL-style generator or layout backend use must pin revisions, technology plugins, PDK/model hashes, generator specs, generated-output hashes, SPICE replay, DRC/LVS/extraction, PVT/corner reports, and analog review",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make padframe-check",
                    "make board-package-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "deterministic-spice-replay-backend-watch",
                "status": "CAPTURED_NOT_SIMULATED",
                "target": "future ngspice, PySpice, Xyce, or OpenVAF use must pin simulator/model/compiler revisions, PDK and model hashes, deck hashes, command lines, raw outputs, convergence logs, PVT/corner manifests, and reviewer disposition before accepting analog AI results",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation",
                    "make padframe-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "analog-design-equation-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future self-calibrating LLM-generated design equations or Python sizing functions must cite constraint traceability, calibration data, SPICE replay, PVT sweeps, sensitivity reports, and reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make padframe-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "schematic-image-netlist-parser-watch",
                "status": "CAPTURED_NOT_PARSED",
                "target": "future schematic image, CircuitJSON, or SPICE-to-schematic tools must prove source hashes, symbol libraries, ERC, electrical equivalence, and reviewer disposition",
                "acceptance_gates": [
                    "make padframe-check",
                    "make package-cross-probe-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "analog-layout-vlm-dataset-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future analog layout VLM datasets must pin snapshots, license terms, synthetic data boundaries, train/test splits, local label mapping, and review before any download or model evaluation",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "analog-spice-corpus-and-model-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future SKY130/SPICE circuit corpora, SPICE-generation benchmarks, or analog-domain models must pin exact revisions, licenses, PDK and ngspice/PySpice provenance, base-model lineage, split/non-overlap review, prompt and output logs, generated SPICE quarantine, PVT/layout evidence, and analog reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make padframe-check",
                    "make no-hardware-action-check",
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
            "no approved ngspice, PySpice, Xyce, or OpenVAF revision/model/deck replay policy for E1 analog or extracted-netlist evidence",
            "no approved BAG3++/OpenFASOC/laygo2/MAGICAL generator or layout-backend revision with technology plugin, PDK, model, generated-output quarantine, DRC/LVS/extraction, SPICE replay, and analog-review evidence",
            "no foundry pad library selected or released",
            "no IBIS, S-parameter, package parasitic, or rail impedance model",
            "no quarantined analog LLM/agent harness with pinned prompts, model versions, memory snapshots, SPICE decks, simulator logs, PVT sweeps, and reviewer disposition",
            "no license-reviewed analog schematic/netlist dataset selected with exact snapshot, non-overlap review, and parser baselines",
            "no license-reviewed analog layout VLM dataset snapshot, synthetic-data boundary review, local label mapping, or download policy",
            "no license-reviewed SKY130/SPICE analog circuit corpus selected with exact revision, PDK provenance, ngspice/PySpice replay policy, split review, and non-overlap review",
            "no approved external analog model intake with base-model license review, training-corpus contamination review, inference logs, and reviewer disposition",
            "no approved LLM/ngspice sizing harness with prompt logs, objective definitions, generated dimension quarantine, PVT/corner sweeps, and extracted-layout replay",
            "no approved design-equation generation workflow with equation traceability, calibration data, sensitivity reports, and reviewer disposition",
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
