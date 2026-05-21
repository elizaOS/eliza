#!/usr/bin/env python3
"""Capture dry-run routing, congestion, and DRC automation targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/routing_congestion_targets"
CLAIM_BOUNDARY = "routing_congestion_target_capture_only_no_route_or_layout_change"

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
    "pd/openlane/run.sh",
    "pd/signoff/manifest.yaml",
    "pd/constraints/e1_pd_smoke.sdc",
    "pd/constraints/e1_soc.sdc",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/pd/dft-evidence.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/pd/high-fanout-routing-pressure-2026-05-18.json",
    "docs/pd/signoff/openlane_release_run_monitor_2026-05-19.md",
    "docs/pd/signoff/openlane_repairantennas_blocker_RUN_2026-05-19_01-52-14.md",
    "docs/pd/signoff/si-pi/local-gap-report.md",
    "research/alpha_chip_macro_placement/01_sources/openroad_openlane_validation.md",
    "scripts/ai_eda/capture_openroad_ml_snapshot.py",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/report_high_fanout_nets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

ROUTE_METRIC_KEYS = (
    "design__wirelength",
    "route__wirelength",
    "route__vias",
    "route__drc_errors",
    "route__antenna_violations",
    "route__wirelength__estimated",
    "route__wirelength__max",
    "route__wirelength__min",
    "design__max_slew_violation__count",
    "design__max_cap_violation__count",
    "design__max_fanout_violation__count",
    "timing__setup__wns",
    "timing__setup__tns",
    "timing__hold__wns",
    "timing__hold__tns",
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


def command_entry(command: str) -> dict[str, str | None]:
    resolved = shutil.which(command)
    return {
        "command": command,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def latest_metrics_path() -> Path | None:
    metrics = sorted(
        (ROOT / "pd/openlane/runs").glob("RUN_*/final/metrics.json"),
        key=lambda path: path.stat().st_mtime,
    )
    return metrics[-1] if metrics else None


def latest_run_dir(metrics_path: Path | None) -> Path | None:
    if metrics_path is None:
        return None
    return metrics_path.parents[1]


def route_metrics(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    metrics = load_json(path)
    return {key: metrics.get(key) for key in ROUTE_METRIC_KEYS if key in metrics}


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


def routing_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*openroad-globalrouting*/openroad-globalrouting*.log",
        "*openroad-globalrouting*/or_metrics_out.json",
        "*openroad-globalrouting*/antenna.rpt",
        "*openroad-globalrouting*/after_grt.guide",
        "*openroad-detailedrouting*/openroad-detailedrouting*.log",
        "*openroad-detailedrouting*/or_metrics_out.json",
        "*openroad-detailedrouting*/*.drc",
        "*odb-reportwirelength*/wire_lengths.csv",
        "*magic-drc*/magic-drc.log",
        "*klayout-drc*/klayout-drc.log",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:24]:
        if not path.is_file():
            continue
        entries.append(
            {
                "path": rel(path),
                "sha256": sha256_file(path),
                "samples": report_sample(
                    path,
                    (
                        r"overflow",
                        r"congestion",
                        r"violation",
                        r"drc",
                        r"antenna",
                        r"wire",
                        r"via",
                        r"route",
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
    metrics_path = latest_metrics_path()
    run_dir = latest_run_dir(metrics_path)
    report = {
        "schema": "eliza.ai_eda.routing_congestion_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_ROUTE_OR_LAYOUT_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "circuitnet",
            "circuitnet-2",
            "routeplacer",
            "openroad-fastroute",
            "openroad-tritonroute",
            "cugr",
            "dr-cu",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_netlist": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_gds": False,
            "changes_guides": False,
            "changes_constraints": False,
            "changes_pd_config": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_router": False,
            "runs_drc": False,
            "runs_antenna_check": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "imports_external_dataset": False,
            "generates_route_guide": False,
            "generates_congestion_map": False,
            "generates_drc_fix": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "routability_claim_allowed": False,
            "drc_claim_allowed": False,
            "timing_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "route_metrics": route_metrics(metrics_path),
        "routing_artifacts": routing_artifacts(run_dir),
        "optional_commands": [
            command_entry("openroad"),
            command_entry("openlane"),
            command_entry("klayout"),
            command_entry("magic"),
        ],
        "candidate_actions": [
            {
                "id": "route-log-and-congestion-label-capture",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "build local labels from OpenROAD global route, detailed route, wirelength, antenna, DRC, DEF, ODB, and signoff artifacts",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_routing_congestion_targets.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "ml-routability-triage-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future CircuitNet/RoutePlacer-style predictors may rank placement or route-risk candidates only after held-out E1 labels exist",
                "acceptance_gates": [
                    "make docs-check",
                    "make no-hardware-action-check",
                    "make pd-signoff-manifest-check",
                    "make power-thermal-evidence-check",
                ],
            },
            {
                "id": "router-parameter-sweep-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future FastRoute/TritonRoute/CU-GR/Dr.CU parameter sweeps must remain isolated until routed DEF/ODB/GDS, DRC, antenna, timing, power, and signoff evidence is archived",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                ],
            },
        ],
        "blocked_by": [
            "no held-out E1 routing and DRC label corpus across repeated OpenLane runs",
            "no approved write-capable route-guide or router-parameter command schema",
            "no license-reviewed external routing dataset import or model checkpoint",
            "current report is advisory and cannot waive global routing, detailed routing, DRC, antenna, timing, power, or signoff failures",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.routing_congestion.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
