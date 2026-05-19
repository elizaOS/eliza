#!/usr/bin/env python3
"""Capture dry-run timing-closure and ECO automation targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/timing_closure_targets"
CLAIM_BOUNDARY = "timing_closure_target_capture_only_no_constraint_or_eco_change"

INPUT_ARTIFACTS = (
    "pd/constraints/e1_soc.sdc",
    "pd/constraints/e1_pd_smoke.sdc",
    "pd/constraints/e1_soc_gf180.sdc",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/signoff/manifest.yaml",
    "scripts/check_pd_closure.py",
)

TIMING_METRIC_KEYS = (
    "timing__setup__wns",
    "timing__setup__tns",
    "timing__setup_vio__count",
    "timing__setup_r2r__ws",
    "timing__setup_r2r_vio__count",
    "timing__hold__wns",
    "timing__hold__tns",
    "timing__hold_vio__count",
    "timing__hold_r2r__ws",
    "timing__hold_r2r_vio__count",
    "design__max_slew_violation__count",
    "design__max_cap_violation__count",
    "design__max_fanout_violation__count",
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


def latest_metrics_path() -> Path | None:
    metrics = sorted(
        (ROOT / "pd/openlane/runs").glob("RUN_*/final/metrics.json"),
        key=lambda path: path.stat().st_mtime,
    )
    return metrics[-1] if metrics else None


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def timing_metrics(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    metrics = load_json(path)
    return {key: metrics.get(key) for key in TIMING_METRIC_KEYS if key in metrics}


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


def latest_run_dir(metrics_path: Path | None) -> Path | None:
    if metrics_path is None:
        return None
    return metrics_path.parents[1]


def timing_report_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    candidates = [
        run_dir / "final/metrics.json",
        *sorted(run_dir.glob("*openroad-sta*/wns.max.rpt")),
        *sorted(run_dir.glob("*openroad-sta*/wns.min.rpt")),
        *sorted(run_dir.glob("*openroad-resizertiming*/openroad-resizertiming*.log")),
    ]
    entries: list[dict[str, Any]] = []
    for path in candidates[:12]:
        if not path.is_file():
            continue
        entries.append(
            {
                "path": rel(path),
                "sha256": sha256_file(path),
                "samples": report_sample(path, (r"wns", r"tns", r"slack", r"violation")),
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
        "schema": "eliza.ai_eda.timing_closure_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_ECO_OR_CONSTRAINT_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "timingpredict",
            "e2eslack",
            "timingllm",
            "fluxeda",
            "openroad-resizer",
            "ir-aware-eco-rl",
        ],
        "policy": {
            "changes_constraints": False,
            "changes_rtl": False,
            "changes_netlist": False,
            "runs_openroad": False,
            "applies_eco": False,
            "prediction_generated": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "timing_metrics": timing_metrics(metrics_path),
        "timing_report_artifacts": timing_report_artifacts(run_dir),
        "optional_commands": [
            command_entry("openroad"),
            command_entry("sta"),
            command_entry("yosys"),
        ],
        "candidate_actions": [
            {
                "id": "pre-route-slack-prediction-dataset",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "build local timing-label rows from SDC, netlist, DEF/ODB, and STA reports",
                "acceptance_gates": [
                    "python3 scripts/check_pd_closure.py",
                    "make openlane-run-preflight-check",
                ],
            },
            {
                "id": "constraint-review-suggestions",
                "status": "CAPTURED_NOT_APPLIED",
                "target": "review SDC completeness and IO-delay assumptions",
                "acceptance_gates": [
                    "make docs-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "openroad-resizer-eco-search",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future advisory sweep over repair_design/repair_timing knobs",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "python3 scripts/check_pd_closure.py",
                    "make synth",
                ],
            },
        ],
        "blocked_by": [
            "no timing predictor trained or calibrated on E1 runs",
            "no version-pinned external timing dataset or model",
            "no approved write-capable ECO command schema",
            "current report is advisory and cannot waive STA or signoff failures",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.timing_closure.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
