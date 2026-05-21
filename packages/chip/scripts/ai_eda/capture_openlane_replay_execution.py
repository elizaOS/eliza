#!/usr/bin/env python3
"""Capture post-execution evidence for deterministic OpenLane/OpenROAD replay.

This script does not run OpenLane. It validates and packages the artifacts that
must come back from a PD host after replay execution before any E1 optimization
claim can be made: metrics, logs, DEF/GDS, source queue/preflight manifests,
and optional DRC/LVS/antenna reports.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_replay_execution"
SCHEMA = "eliza.ai_eda.openlane_replay_execution.v1"
CLAIM_BOUNDARY = "openlane_replay_execution_evidence_only_no_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def artifact(path: Path, required: bool) -> dict[str, Any]:
    return {
        "path": rel(path),
        "required": required,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--openlane-log", type=Path, required=True)
    parser.add_argument("--openroad-log", type=Path, required=True)
    parser.add_argument("--def-file", type=Path, required=True)
    parser.add_argument("--gds-file", type=Path, required=True)
    parser.add_argument("--replay-queue", type=Path)
    parser.add_argument("--replay-preflight", type=Path)
    parser.add_argument("--drc-report", type=Path)
    parser.add_argument("--lvs-report", type=Path)
    parser.add_argument("--antenna-report", type=Path)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    queue_path = args.replay_queue or (
        ROOT / f"build/ai_eda/macro_placement_replay_queue/{args.run_id}/replay_queue.json"
    )
    preflight_path = args.replay_preflight or (
        ROOT
        / f"build/ai_eda/macro_placement_replay_preflight/{args.run_id}/replay_preflight_report.json"
    )
    required = {
        "metrics": repo_path(str(args.metrics)),
        "openlane_log": repo_path(str(args.openlane_log)),
        "openroad_log": repo_path(str(args.openroad_log)),
        "def": repo_path(str(args.def_file)),
        "gds": repo_path(str(args.gds_file)),
        "replay_queue": repo_path(str(queue_path)),
        "replay_preflight": repo_path(str(preflight_path)),
    }
    optional = {
        "drc_report": repo_path(str(args.drc_report)) if args.drc_report else None,
        "lvs_report": repo_path(str(args.lvs_report)) if args.lvs_report else None,
        "antenna_report": repo_path(str(args.antenna_report)) if args.antenna_report else None,
    }
    blockers: list[str] = []
    artifacts = {name: artifact(path, True) for name, path in required.items()}
    for name, item in artifacts.items():
        if item["status"] != "PRESENT":
            blockers.append(f"required artifact missing: {name}")
    artifacts.update(
        {
            name: artifact(path, False)
            for name, path in optional.items()
            if path is not None
        }
    )

    metrics = load_json(required["metrics"])
    if metrics is None:
        blockers.append("metrics JSON is missing or unreadable")
    else:
        metric_keys = {str(key).lower() for key in metrics}
        if not any("wns" in key or "slack" in key for key in metric_keys):
            blockers.append("metrics JSON does not expose timing/slack keys")
        if not any("drc" in key for key in metric_keys):
            blockers.append("metrics JSON does not expose DRC keys")
    queue = load_json(required["replay_queue"])
    if queue is not None:
        candidates = [
            item.get("candidate_id")
            for item in queue.get("queue", [])
            if isinstance(item, dict)
        ]
        if args.candidate_id not in candidates:
            blockers.append("candidate_id is not present in replay queue")
    preflight = load_json(required["replay_preflight"])
    if preflight is not None and preflight.get("candidate_id") != args.candidate_id:
        blockers.append("replay preflight candidate_id does not match execution candidate_id")

    status = "EXECUTED_REPLAY_EVIDENCE_READY" if not blockers else "BLOCKED_EXECUTION_EVIDENCE"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "candidate_id": args.candidate_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "optimization_claim_allowed": status == "EXECUTED_REPLAY_EVIDENCE_READY",
        "status": status,
        "artifacts": artifacts,
        "metric_summary": metrics if isinstance(metrics, dict) else {},
        "blockers": blockers,
        "next_required_gates": [
            "compare candidate replay metrics against baseline E1 replay metrics",
            "review OpenLane/OpenROAD logs for warnings and non-determinism",
            "run human PD review before source or release promotion",
            "promote only through signed objective-readiness evidence",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "openlane_replay_execution.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.openlane_replay_execution "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
