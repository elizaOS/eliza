#!/usr/bin/env python3
"""Capture advisory E1 PD predictor labels from local OpenLane artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/pd_predictor_dataset"
OPENLANE_RUNS = ROOT / "pd/openlane/runs"
CLAIM_BOUNDARY = "predictor_dataset_advisory_only_not_signoff_or_release_evidence"
FALSE_CLAIM_FLAGS = {"signoff_claim_allowed": False}

ARTIFACT_CANDIDATES = (
    ("final_def", ("results/final/def/e1_soc.def", "final/def/e1_soc.def")),
    ("final_odb", ("results/final/odb/e1_soc.odb", "final/odb/e1_soc.odb")),
    ("final_netlist", ("results/final/verilog/gl/e1_soc.v", "final/verilog/gl/e1_soc.v")),
    ("metrics", ("reports/metrics.csv", "metrics.csv", "reports/final_summary_report.csv")),
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--openlane-run", type=Path)
    return parser.parse_args()


def latest_openlane_run() -> Path | None:
    if not OPENLANE_RUNS.is_dir():
        return None
    runs = [path for path in OPENLANE_RUNS.iterdir() if path.is_dir()]
    if not runs:
        return None
    return max(runs, key=lambda path: path.stat().st_mtime)


def artifact_entry(run_dir: Path, name: str, candidates: tuple[str, ...]) -> dict[str, Any]:
    for candidate in candidates:
        path = run_dir / candidate
        if path.is_file():
            return {
                "name": name,
                "status": "PRESENT",
                "path": rel(path),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
    return {
        "name": name,
        "status": "MISSING",
        "path": None,
        "sha256": None,
        "bytes": 0,
    }


def tool_versions() -> dict[str, str]:
    return {
        "python": sys.version.split()[0],
        "openlane": "not_probed_by_dry_run",
        "openroad": "not_probed_by_dry_run",
    }


def main() -> int:
    args = parse_args()
    run_dir = args.openlane_run.resolve() if args.openlane_run else latest_openlane_run()
    out_dir = (args.out_root / args.run_id).resolve()
    artifacts: list[dict[str, Any]] = []
    if run_dir and run_dir.is_dir():
        artifacts = [
            artifact_entry(run_dir, name, candidates) for name, candidates in ARTIFACT_CANDIDATES
        ]
        run_status = "OPENLANE_RUN_FOUND"
        run_path = rel(run_dir)
    else:
        run_status = "NO_OPENLANE_RUN_FOUND"
        run_path = None

    manifest = {
        "schema": "eliza.ai_eda.pd_predictor.snapshot_manifest.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "status": run_status,
        "claim_boundary": CLAIM_BOUNDARY,
        "source_run": run_path,
        "tool_versions": tool_versions(),
        "artifacts": artifacts,
        "split_policy": {
            "holdout_ready": False,
            "minimum_runs_before_training": 5,
            "predictor_outputs_advisory_only": True,
        },
    }
    labels = {
        "schema": "eliza.ai_eda.pd_predictor.label_report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "status": "DRY_RUN_LABEL_CAPTURE",
        "claim_boundary": CLAIM_BOUNDARY,
        "signoff_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "labels": {
            "timing": "not_extracted",
            "power": "not_extracted",
            "congestion": "not_extracted",
            "drc": "not_extracted",
        },
        "blocked_by": [
            "stable OpenLane final artifact set",
            "repeated runs for hold-out split",
            "feature schema and predictor validation report",
        ],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "snapshot_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    (out_dir / "label_report.json").write_text(json.dumps(labels, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.pd_predictor_dataset.snapshot {rel(out_dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
