#!/usr/bin/env python3
"""Capture dry-run floorplan, IO placement, tapcell, and PDN targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorplan_io_pdn_targets"
CLAIM_BOUNDARY = "floorplan_io_pdn_target_capture_only_no_floorplan_or_power_grid_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/openlane/config.ihp-sg13g2.json",
    "pd/openlane/floorplan.tcl",
    "pd/pin_order.cfg",
    "pd/pin_order_smoke.cfg",
    "pd/padframe/e1_demo_padframe.yaml",
    "pd/signoff/manifest.yaml",
    "pd/signoff/pdn-current/local-budget.yaml",
    "pd/signoff/si-pi/local-evidence.yaml",
    "pd/signoff/waivers/pdn-open-flow-waiver.yaml",
    "docs/pd/floorplans/e1_soc.md",
    "docs/pd/macro-placement.md",
    "docs/evidence/pd/macro-placement-evidence.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/evidence/power/rail-plan-evidence.yaml",
    "docs/board/pdn-budget.md",
    "docs/pd/padframe/e1_demo_padframe.md",
    "docs/package/e1-demo-pad-ring.md",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/check_padframe_contract.py",
    "scripts/check_si_pi_pdn_evidence.py",
    "scripts/check_pdn_workload_signoff.py",
    "scripts/ai_eda/capture_placement_legalization_targets.py",
    "scripts/ai_eda/capture_power_thermal_targets.py",
    "scripts/ai_eda/capture_board_package_fpga_targets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = ("openroad", "openlane", "python3")


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


def command_entry(command: str) -> dict[str, str | None]:
    resolved = shutil.which(command)
    return {"command": command, "status": "PRESENT" if resolved else "MISSING", "path": resolved}


def latest_openlane_run_dir() -> Path | None:
    metrics = sorted(
        (ROOT / "pd/openlane/runs").glob("RUN_*/final/metrics.json"),
        key=lambda path: path.stat().st_mtime,
    )
    if not metrics:
        return None
    return metrics[-1].parents[1]


def report_sample(path: Path, patterns: tuple[str, ...], limit: int = 12) -> list[str]:
    if not path.is_file():
        return []
    compiled = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    samples: list[str] = []
    for line in path.read_text(errors="replace").splitlines():
        if any(pattern.search(line) for pattern in compiled):
            samples.append(line.strip())
            if len(samples) >= limit:
                break
    return samples


def floorplan_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*openroad-floorplan*/**/*",
        "*openroad-ioplacer*/**/*",
        "*openroad-tapcell*/**/*",
        "*openroad-pdn*/**/*",
        "*pdn*/**/*.log",
        "*pdn*/**/*.rpt",
        "*floorplan*/**/*.log",
        "*floorplan*/**/*.rpt",
        "*ioplacer*/**/*.log",
        "*tapcell*/**/*.log",
        "final/def/*.def",
        "final/odb/*.odb",
        "final/metrics.json",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:72]:
        if not path.is_file():
            continue
        entries.append(
            {
                "path": rel(path),
                "sha256": sha256_file(path),
                "size_bytes": path.stat().st_size,
                "samples": report_sample(
                    path,
                    (
                        r"floorplan",
                        r"die",
                        r"core",
                        r"pin",
                        r"pad",
                        r"io",
                        r"tap",
                        r"endcap",
                        r"pdn",
                        r"power",
                        r"grid",
                        r"macro",
                        r"error",
                        r"warning",
                        r"fail",
                    ),
                ),
            }
        )
    return entries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_dir = latest_openlane_run_dir()
    report = {
        "schema": "eliza.ai_eda.floorplan_io_pdn_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_FLOORPLAN_IO_OR_PDN_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openroad-ifp",
            "openroad-rtlmp",
            "openroad-ioplacer",
            "openroad-tapcell",
            "openroad-pdn",
            "openlane-floorplanning",
            "floorset",
            "piano-floorplanner",
            "ibm-fp-opt",
            "nl2gds",
            "openpdn",
        ],
        "policy": {
            "changes_floorplan": False,
            "changes_die_area": False,
            "changes_core_area": False,
            "changes_macro_placement": False,
            "changes_io_placement": False,
            "changes_pin_order": False,
            "changes_padframe": False,
            "changes_pdn": False,
            "changes_tapcell": False,
            "changes_endcap": False,
            "changes_tracks": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_gds": False,
            "changes_pd_config": False,
            "changes_constraints": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_floorplan": False,
            "runs_ioplacer": False,
            "runs_tapcell": False,
            "runs_pdngen": False,
            "runs_pdn_analysis": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "imports_external_benchmarks": False,
            "generates_floorplan": False,
            "generates_pin_assignment": False,
            "generates_pdn": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "floorplan_claim_allowed": False,
            "pinout_claim_allowed": False,
            "pdn_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "floorplan_artifacts": floorplan_artifacts(run_dir),
        "optional_commands": [command_entry(command) for command in OPTIONAL_COMMANDS],
        "candidate_tasks": [
            {
                "id": "floorplan-io-pdn-log-triage-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "hash floorplan, IO placement, tap/endcap, PDN, pin-order, padframe, DEF, ODB, metrics, and signoff inputs before any AI triage",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "generated-floorplan-quarantine-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future LLM, RL, mixed-variable, or dataset-trained floorplan candidates remain quarantined until deterministic OpenLane replay and signoff exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_power_thermal_targets.py --run-id validation",
                    "make padframe-check",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
            {
                "id": "macro-placement-baseline-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future OpenROAD RTLMP-style macro placement requires release-ready macro manifests, halos, blockages, package and PDN constraints, deterministic replay, routing, STA, DRC/LVS, antenna, power, and review",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation",
                    "make pd-signoff-manifest-check",
                    "make power-thermal-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "pin-pdn-generation-quarantine-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future generated pin orders, pad rings, tap/endcap settings, and PDN grids require package, SI/PI, power, routing, DRC/LVS, and reviewer gates",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_board_package_fpga_targets.py --run-id validation",
                    "make power-thermal-evidence-check",
                    "make pdn-workload-signoff",
                    "make manufacturing-artifacts-check",
                    "make commercial-eda-gate",
                ],
            },
        ],
        "blocked_by": [
            "no accepted write-capable schema for die/core area, IO placement, pin order, padframe, tap/endcap, track, PDN, DEF, ODB, Tcl, or patch edits",
            "no repeated completed E1 OpenLane floorplan-to-signoff corpus with held-out labels for AI floorplanning or PDN validation",
            "no release-ready hard-macro manifest, halo/blockage policy, package constraints, or macro-placement replay logs",
            "no license-reviewed import path for external floorplanning datasets, generated floorplans, or pretrained floorplanning models",
            "no release gate allowing AI floorplan, pin, tapcell, padframe, or PDN output to bypass package, SI/PI, power, routing, STA, DRC/LVS/antenna, manufacturing, commercial-EDA, and reviewer gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.floorplan_io_pdn.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
