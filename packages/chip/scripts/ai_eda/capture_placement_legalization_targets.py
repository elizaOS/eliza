#!/usr/bin/env python3
"""Capture dry-run placement, legalization, and density optimization targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/placement_legalization_targets"
CLAIM_BOUNDARY = "placement_legalization_target_capture_only_no_placement_or_pd_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "research/alpha_chip_macro_placement/01_sources/openroad_openlane_validation.md",
    "research/alpha_chip_macro_placement/01_sources/google_circuit_training.md",
    "research/alpha_chip_macro_placement/01_sources/tilos_macroplacement.md",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/openlane/config.ihp-sg13g2.json",
    "pd/openlane/run.sh",
    "pd/signoff/manifest.yaml",
    "pd/constraints/e1_soc.sdc",
    "pd/constraints/e1_pd_smoke.sdc",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/pd/high-fanout-routing-pressure-2026-05-18.json",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/ai_eda/run_openroad_autotune_e1.sh",
    "scripts/ai_eda/capture_openroad_ml_snapshot.py",
    "scripts/ai_eda/capture_routing_congestion_targets.py",
    "scripts/ai_eda/capture_timing_closure_targets.py",
    "scripts/ai_eda/capture_physical_verification_targets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "openroad",
    "openlane",
    "python3",
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


def command_entry(command: str) -> dict[str, str | None]:
    resolved = shutil.which(command)
    return {
        "command": command,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


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


def placement_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*openroad-globalplacement*/**/*.log",
        "*openroad-globalplacement*/**/*.rpt",
        "*openroad-globalplacement*/**/*.def",
        "*openroad-globalplacement*/**/*.odb",
        "*openroad-detailedplacement*/**/*.log",
        "*openroad-detailedplacement*/**/*.rpt",
        "*openroad-detailedplacement*/**/*.def",
        "*openroad-detailedplacement*/**/*.odb",
        "*openroad-resizertiming*/**/*.log",
        "*openroad-resizertiming*/**/*.rpt",
        "*odbpy-report-disconnected-pins*/**/*.log",
        "*check_macro_placement*/**/*",
        "final/def/*.def",
        "final/odb/*.odb",
        "final/metrics.json",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:64]:
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
                        r"place",
                        r"placement",
                        r"legal",
                        r"density",
                        r"overflow",
                        r"hpwl",
                        r"timing",
                        r"congestion",
                        r"displacement",
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
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_dir = latest_openlane_run_dir()
    report = {
        "schema": "eliza.ai_eda.placement_legalization_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_PLACEMENT_OR_PD_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openroad-gpl",
            "openroad-dpl",
            "openroad-rtlmp",
            "google-circuit-training",
            "tilos-macroplacement",
            "autodmp",
            "dreamplace",
            "xplace",
            "chipdiffusion",
            "diffplace",
            "flowplace",
            "chipbench-d",
            "routeplacer",
            "wiremask-bbo",
            "bboplace-bench",
            "macro-place-challenge-2026",
        ],
        "policy": {
            "changes_floorplan": False,
            "changes_placement": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_gds": False,
            "changes_pd_config": False,
            "changes_constraints": False,
            "changes_netlist": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_global_placement": False,
            "runs_detailed_placement": False,
            "runs_legalization": False,
            "runs_filler_placement": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "imports_external_benchmarks": False,
            "generates_placement": False,
            "generates_density_change": False,
            "generates_padding_change": False,
            "generates_macro_placement": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "placement_qor_claim_allowed": False,
            "timing_claim_allowed": False,
            "routability_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "placement_artifacts": placement_artifacts(run_dir),
        "optional_commands": [command_entry(command) for command in OPTIONAL_COMMANDS],
        "candidate_tasks": [
            {
                "id": "openroad-placement-log-triage-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "hash GPL, DPL, legalization, filler, placement check, metrics, DEF, and ODB artifacts before any AI triage ranks placement blockers",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "generative-placement-quarantine-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future diffusion, flow-matching, RL, or LLM-generated placements remain citation-only until local E1 constraints, legalizer, routing, timing, and signoff replay exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_routing_congestion_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_timing_closure_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_physical_verification_targets.py --run-id validation",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
            {
                "id": "macro-placement-bbo-benchmark-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future RTLMP, WireMask-BBO, BBOPlace-Bench, or macro-placement challenge use requires macro manifests, exact revisions, license and split review, generated-output quarantine, legalizer replay, routing, STA, DRC/LVS, antenna, PDN, power, and review",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation",
                    "make pd-signoff-manifest-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "placement-parameter-autotune-quarantine-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future density, padding, routability, timing-driven, legalization, and filler-placement parameter sweeps must be replayable and cannot bypass signoff",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id validation",
                    "scripts/ai_eda/run_openroad_autotune_e1.sh --run-id validation",
                    "make synth",
                    "make power-thermal-evidence-check",
                    "make commercial-eda-gate",
                ],
            },
        ],
        "blocked_by": [
            "no repeated completed E1 OpenLane placement-to-route runs with held-out labels for placement model validation",
            "no accepted write-capable schema for placement, density, padding, legalizer, filler, DEF, ODB, Tcl, or macro-placement edits",
            "no license-reviewed import path for external placement benchmarks, generated placements, or pretrained placement models",
            "no release-ready hard-macro manifest, macro-placement benchmark non-overlap review, or hidden/public split policy for competition-style tasks",
            "no release gate allowing AI placement output to bypass deterministic OpenROAD/OpenLane, routing, STA, DRC/LVS/antenna, power, manufacturing, and reviewer gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.placement_legalization.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
