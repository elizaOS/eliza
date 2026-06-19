#!/usr/bin/env python3
"""Capture dry-run CTS and clock-network automation targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/clock_tree_targets"
CLAIM_BOUNDARY = "clock_tree_target_capture_only_no_cts_or_clocking_change"

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
    "pd/constraints/e1_pd_smoke.sdc",
    "pd/constraints/e1_soc.sdc",
    "pd/signoff/manifest.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/pd/signoff/openlane_release_run_monitor_2026-05-19.md",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/ai_eda/capture_timing_closure_targets.py",
    "scripts/ai_eda/capture_routing_congestion_targets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

CLOCK_METRIC_KEYS = (
    "clock__skew",
    "clock__latency",
    "clock__buffers",
    "clock__nets",
    "clock__sinks",
    "design__instance__count__buf",
    "design__instance__count__buf__clock",
    "timing__hold__wns",
    "timing__hold__tns",
    "timing__hold_vio__count",
    "timing__setup__wns",
    "timing__setup__tns",
    "timing__setup_vio__count",
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


def clock_metrics(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    metrics = load_json(path)
    return {key: metrics.get(key) for key in CLOCK_METRIC_KEYS if key in metrics}


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


def clock_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*openroad-cts*/cts.rpt",
        "*openroad-cts*/openroad-cts*.log",
        "*openroad-cts*/or_metrics_out.json",
        "*openroad-cts*/e1_pd_smoke_top.def",
        "*openroad-cts*/e1_pd_smoke_top.odb",
        "*openroad-stamidpnr*/clock.rpt",
        "*openroad-stamidpnr*/skew.max.rpt",
        "*openroad-stamidpnr*/skew.min.rpt",
        "*openroad-resizertimingpostcts*/openroad-resizertimingpostcts*.log",
        "*openroad-resizertimingpostcts*/or_metrics_out.json",
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
                        r"clock",
                        r"cts",
                        r"skew",
                        r"latency",
                        r"sink",
                        r"buffer",
                        r"hold",
                        r"setup",
                        r"violation",
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
    metrics_path = latest_metrics_path()
    run_dir = latest_run_dir(metrics_path)
    report = {
        "schema": "eliza.ai_eda.clock_tree_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_CTS_OR_CLOCKING_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openroad-cts",
            "tritoncts",
            "gan-cts",
            "cts-bench",
            "openroad-two-phase-clock",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_netlist": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_sdc": False,
            "changes_pd_config": False,
            "changes_clocking_scheme": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_cts": False,
            "runs_sta": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "imports_external_dataset": False,
            "generates_clock_tree": False,
            "generates_clock_constraints": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "skew_claim_allowed": False,
            "hold_claim_allowed": False,
            "power_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "clock_metrics": clock_metrics(metrics_path),
        "clock_artifacts": clock_artifacts(run_dir),
        "optional_commands": [
            command_entry("openroad"),
            command_entry("openlane"),
            command_entry("yosys"),
        ],
        "candidate_actions": [
            {
                "id": "cts-log-and-skew-label-capture",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "build local labels from OpenROAD CTS reports, clock skew reports, post-CTS timing repair logs, DEF/ODB snapshots, and STA reports",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_clock_tree_targets.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "ml-cts-skew-prediction-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future CTS-Bench or GAN-CTS-style models may rank skew/latency risk only after held-out E1 clock labels exist",
                "acceptance_gates": [
                    "make docs-check",
                    "make no-hardware-action-check",
                    "make pd-signoff-manifest-check",
                    "make power-thermal-evidence-check",
                ],
            },
            {
                "id": "clocking-conversion-watch",
                "status": "CAPTURED_NOT_APPLIED",
                "target": "future two-phase clocking or clock-tree conversion remains research-only until equivalence, DFT, CDC/RDC, STA, power, routing, and signoff gates exist",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "python3 scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation",
                    "make pd-signoff-manifest-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no held-out E1 CTS/skew/latency label corpus across repeated OpenLane runs",
            "no approved write-capable CTS, clock-buffer, useful-skew, or clocking-conversion command schema",
            "no license-reviewed external CTS dataset import or model checkpoint",
            "current report is advisory and cannot waive CTS, hold, setup, DFT, CDC/RDC, power, route, or signoff failures",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.clock_tree.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
