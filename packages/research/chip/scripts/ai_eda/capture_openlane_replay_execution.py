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
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_replay_execution"
SCHEMA = "eliza.ai_eda.openlane_replay_execution.v1"
HANDOFF_SCHEMA = "eliza.ai_eda.openlane_replay_handoff.v1"
CLAIM_BOUNDARY = "openlane_replay_execution_evidence_only_no_release_claim"


def false_claim_flags(status: str) -> dict[str, bool]:
    flags = {"release_use_allowed": False}
    if status != "EXECUTED_REPLAY_EVIDENCE_READY":
        flags["optimization_claim_allowed"] = False
    return flags


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


def flatten_metrics(value: Any, prefix: str = "") -> dict[str, float]:
    metrics: dict[str, float] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            metrics.update(flatten_metrics(child, name))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        metrics[prefix] = float(value)
    return metrics


def summarize_metric_keys(metrics: dict[str, Any] | None) -> dict[str, Any]:
    flattened = flatten_metrics(metrics or {})
    lowered = [key.lower() for key in flattened]
    timing_keys = [
        key
        for key in flattened
        if any(
            token in key.lower()
            for token in ("wns", "tns", "slack", "fmax", "frequency", "timing", "__ws")
        )
    ]
    drc_keys = [
        key
        for key in flattened
        if any(token in key.lower() for token in ("drc", "violat", "antenna", "lvs"))
    ]
    objective_keys = [
        key
        for key in flattened
        if any(
            token in key.lower()
            for token in ("area", "power", "wire", "length", "congestion", "overflow", "runtime")
        )
    ]
    return {
        "numeric_metric_count": len(flattened),
        "has_timing_metric": bool(timing_keys),
        "has_drc_or_signoff_metric": bool(drc_keys),
        "has_objective_metric": bool(objective_keys),
        "timing_keys": sorted(timing_keys)[:20],
        "drc_or_signoff_keys": sorted(drc_keys)[:20],
        "objective_keys": sorted(objective_keys)[:20],
        "all_numeric_keys_sample": sorted(lowered)[:40],
    }


LOG_ERROR_RE = re.compile(r"\b(ERROR|FATAL|Traceback|CRITICAL)\b", re.IGNORECASE)


def summarize_log(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {
            "path": rel(path),
            "status": "MISSING",
            "line_count": 0,
            "error_like_line_count": 0,
            "error_like_samples": [],
        }
    samples: list[str] = []
    line_count = 0
    error_like = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line_count += 1
            stripped = line.strip()
            if LOG_ERROR_RE.search(stripped):
                error_like += 1
                if len(samples) < 10:
                    samples.append(stripped[:240])
    return {
        "path": rel(path),
        "status": "PRESENT",
        "line_count": line_count,
        "error_like_line_count": error_like,
        "error_like_samples": samples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--replay-role", choices=("baseline", "candidate"), default="candidate")
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--openlane-log", type=Path, required=True)
    parser.add_argument("--openroad-log", type=Path, required=True)
    parser.add_argument("--def-file", type=Path, required=True)
    parser.add_argument("--gds-file", type=Path, required=True)
    parser.add_argument("--replay-queue", type=Path)
    parser.add_argument("--replay-preflight", type=Path)
    parser.add_argument("--replay-handoff", type=Path)
    parser.add_argument("--drc-report", type=Path)
    parser.add_argument("--lvs-report", type=Path)
    parser.add_argument("--antenna-report", type=Path)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    required = {
        "metrics": repo_path(str(args.metrics)),
        "openlane_log": repo_path(str(args.openlane_log)),
        "openroad_log": repo_path(str(args.openroad_log)),
        "def": repo_path(str(args.def_file)),
        "gds": repo_path(str(args.gds_file)),
    }
    if args.replay_role == "candidate":
        queue_path = args.replay_queue or (
            ROOT / f"build/ai_eda/macro_placement_replay_queue/{args.run_id}/replay_queue.json"
        )
        preflight_path = args.replay_preflight or (
            ROOT
            / f"build/ai_eda/macro_placement_replay_preflight/{args.run_id}/replay_preflight_report.json"
        )
        required["replay_queue"] = repo_path(str(queue_path))
        required["replay_preflight"] = repo_path(str(preflight_path))
        if args.replay_handoff:
            required["replay_handoff"] = repo_path(str(args.replay_handoff))
    else:
        queue_path = args.replay_queue
        preflight_path = args.replay_preflight
        if args.replay_queue:
            required["replay_queue"] = repo_path(str(args.replay_queue))
        if args.replay_preflight:
            required["replay_preflight"] = repo_path(str(args.replay_preflight))
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
        {name: artifact(path, False) for name, path in optional.items() if path is not None}
    )

    metrics = load_json(required["metrics"])
    metric_key_summary = summarize_metric_keys(metrics)
    if metrics is None:
        blockers.append("metrics JSON is missing or unreadable")
    else:
        if not metric_key_summary["has_timing_metric"]:
            blockers.append("metrics JSON does not expose timing/slack keys")
        if not metric_key_summary["has_drc_or_signoff_metric"]:
            blockers.append("metrics JSON does not expose DRC/signoff keys")
        if not metric_key_summary["has_objective_metric"]:
            blockers.append("metrics JSON does not expose objective metrics")
    log_summary = {
        "openlane_log": summarize_log(required["openlane_log"]),
        "openroad_log": summarize_log(required["openroad_log"]),
    }
    for label, summary in log_summary.items():
        if summary["status"] != "PRESENT":
            continue
        if summary["line_count"] <= 0:
            blockers.append(f"{label} is empty")
        if summary["error_like_line_count"] > 0:
            blockers.append(f"{label} contains error/fatal lines")
    queue = load_json(required["replay_queue"]) if "replay_queue" in required else None
    queue_candidates = [
        item.get("candidate_id")
        for item in (queue.get("queue", []) if isinstance(queue, dict) else [])
        if isinstance(item, dict)
    ]
    handoff_candidates: list[Any] = []
    if args.replay_role == "candidate" and not args.replay_handoff:
        blockers.append("replay handoff manifest is required for candidate execution evidence")
    if args.replay_handoff:
        handoff = load_json(required["replay_handoff"])
        if handoff is None:
            blockers.append("replay handoff manifest is missing or unreadable")
        else:
            if handoff.get("schema") != HANDOFF_SCHEMA:
                blockers.append("replay handoff schema mismatch")
            if handoff.get("status") != "HANDOFF_READY_FOR_PD_HOST":
                blockers.append(f"replay handoff is not ready: status={handoff.get('status')}")
            if handoff.get("optimization_claim_allowed") is not False:
                blockers.append("replay handoff must not allow optimization claims")
            handoff_candidates = [
                item.get("candidate_id")
                for item in handoff.get("ready_candidates", [])
                if isinstance(item, dict)
            ]
    in_handoff = args.candidate_id in handoff_candidates
    if (
        args.replay_role == "candidate"
        and args.candidate_id not in queue_candidates
        and not in_handoff
    ):
        blockers.append("candidate_id is not present in replay queue or handoff")
    preflight = load_json(required["replay_preflight"]) if "replay_preflight" in required else None
    if (
        args.replay_role == "candidate"
        and preflight is not None
        and preflight.get("candidate_id") != args.candidate_id
        and not in_handoff
    ):
        blockers.append("replay preflight candidate_id does not match execution candidate_id")

    status = "EXECUTED_REPLAY_EVIDENCE_READY" if not blockers else "BLOCKED_EXECUTION_EVIDENCE"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "replay_role": args.replay_role,
        "candidate_id": args.candidate_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "optimization_claim_allowed": status == "EXECUTED_REPLAY_EVIDENCE_READY",
        "false_claim_flags": false_claim_flags(status),
        "status": status,
        "artifacts": artifacts,
        "metric_summary": metrics if isinstance(metrics, dict) else {},
        "metric_key_summary": metric_key_summary,
        "log_summary": log_summary,
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
