#!/usr/bin/env python3
"""Capture baseline-vs-candidate OpenLane/OpenROAD replay comparison evidence.

This script does not run OpenLane. It compares two previously captured
openlane_replay_execution reports and records whether the candidate has enough
hash-pinned evidence for an E1 optimization claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_replay_comparison"
EXECUTION_SCHEMA = "eliza.ai_eda.openlane_replay_execution.v1"
SCHEMA = "eliza.ai_eda.openlane_replay_comparison.v1"
CLAIM_BOUNDARY = "openlane_replay_comparison_evidence_only_no_release_claim"


def false_claim_flags(status: str) -> dict[str, bool]:
    flags = {"release_use_allowed": False}
    if status != "COMPARISON_READY":
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


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
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


def direction_for_metric(name: str) -> str:
    lowered = name.lower()
    if any(token in lowered for token in ("wns", "slack", "frequency", "fmax", "__ws")):
        return "higher_is_better"
    if any(
        token in lowered
        for token in (
            "drc",
            "violat",
            "tns_abs",
            "wire",
            "length",
            "power",
            "area",
            "congestion",
            "overflow",
            "runtime",
            "delay",
        )
    ):
        return "lower_is_better"
    if "tns" in lowered or "timing" in lowered:
        return "higher_is_better"
    return "observed_only"


def compare_metrics(
    baseline: dict[str, Any], candidate: dict[str, Any], tolerance: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    base = flatten_metrics(baseline)
    cand = flatten_metrics(candidate)
    comparisons: list[dict[str, Any]] = []
    improvements: list[dict[str, Any]] = []
    regressions: list[dict[str, Any]] = []
    for name in sorted(set(base) & set(cand)):
        direction = direction_for_metric(name)
        before = base[name]
        after = cand[name]
        delta = after - before
        if direction == "lower_is_better":
            improved = delta < -tolerance
            regressed = delta > tolerance
        elif direction == "higher_is_better":
            improved = delta > tolerance
            regressed = delta < -tolerance
        else:
            improved = False
            regressed = False
        row = {
            "metric": name,
            "baseline": before,
            "candidate": after,
            "delta": delta,
            "direction": direction,
            "status": "IMPROVED" if improved else "REGRESSED" if regressed else "UNCHANGED",
        }
        comparisons.append(row)
        if improved:
            improvements.append(row)
        if regressed and is_signoff_metric(name):
            regressions.append(row)
    return comparisons, improvements, regressions


def is_signoff_metric(name: str) -> bool:
    lowered = name.lower()
    return any(
        token in lowered
        for token in ("wns", "tns", "slack", "timing", "__ws", "drc", "violat", "antenna", "lvs")
    )


def execution_ready(report: dict[str, Any] | None) -> tuple[bool, str]:
    if report is None:
        return False, "missing report"
    if report.get("schema") != EXECUTION_SCHEMA:
        return False, "schema mismatch"
    if report.get("status") != "EXECUTED_REPLAY_EVIDENCE_READY":
        return False, f"status={report.get('status')}"
    if report.get("optimization_claim_allowed") is not True:
        return False, "execution report does not allow optimization gate"
    if not isinstance(report.get("metric_summary"), dict) or not report["metric_summary"]:
        return False, "metric_summary missing"
    return True, "ready"


def replay_role(report: dict[str, Any] | None) -> str | None:
    if not isinstance(report, dict):
        return None
    role = report.get("replay_role", "candidate")
    return str(role) if role in {"baseline", "candidate"} else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--baseline-execution",
        type=Path,
        required=True,
        help="Baseline openlane_replay_execution.json.",
    )
    parser.add_argument(
        "--candidate-execution",
        type=Path,
        required=True,
        help="Candidate openlane_replay_execution.json.",
    )
    parser.add_argument("--metric-tolerance", type=float, default=1e-9)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    baseline_path = repo_path(str(args.baseline_execution))
    candidate_path = repo_path(str(args.candidate_execution))
    baseline = load_json(baseline_path)
    candidate = load_json(candidate_path)
    blockers: list[str] = []

    baseline_ready, baseline_detail = execution_ready(baseline)
    candidate_ready, candidate_detail = execution_ready(candidate)
    if not baseline_ready:
        blockers.append(f"baseline execution not ready: {baseline_detail}")
    if not candidate_ready:
        blockers.append(f"candidate execution not ready: {candidate_detail}")
    if baseline_path == candidate_path:
        blockers.append("baseline and candidate execution reports must be distinct")
    if baseline_ready and replay_role(baseline) != "baseline":
        blockers.append("baseline execution report must have replay_role=baseline")
    if candidate_ready and replay_role(candidate) != "candidate":
        blockers.append("candidate execution report must have replay_role=candidate")

    comparisons: list[dict[str, Any]] = []
    improvements: list[dict[str, Any]] = []
    signoff_regressions: list[dict[str, Any]] = []
    if baseline_ready and candidate_ready and baseline and candidate:
        comparisons, improvements, signoff_regressions = compare_metrics(
            baseline.get("metric_summary", {}),
            candidate.get("metric_summary", {}),
            args.metric_tolerance,
        )
        if not comparisons:
            blockers.append("baseline and candidate have no comparable numeric metrics")
        if signoff_regressions:
            blockers.append("candidate regresses timing/DRC/LVS/antenna signoff metrics")
        if not improvements:
            blockers.append("candidate has no objective metric improvement over baseline")

    status = "COMPARISON_READY" if not blockers else "BLOCKED_COMPARISON_EVIDENCE"
    baseline_id = baseline.get("candidate_id") if isinstance(baseline, dict) else None
    candidate_id = candidate.get("candidate_id") if isinstance(candidate, dict) else None
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "optimization_claim_allowed": status == "COMPARISON_READY",
        "false_claim_flags": false_claim_flags(status),
        "status": status,
        "baseline_candidate_id": baseline_id,
        "candidate_id": candidate_id,
        "artifacts": {
            "baseline_execution": artifact(baseline_path),
            "candidate_execution": artifact(candidate_path),
        },
        "comparison_count": len(comparisons),
        "improvement_count": len(improvements),
        "signoff_regression_count": len(signoff_regressions),
        "comparisons": comparisons,
        "improvements": improvements,
        "signoff_regressions": signoff_regressions,
        "blockers": blockers,
        "next_required_gates": [
            "review logs and metrics for both baseline and candidate replay runs",
            "archive DRC/LVS/antenna reports where available",
            "require human PD review before source or release promotion",
            "promote only through signed objective-readiness evidence",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "openlane_replay_comparison.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.openlane_replay_comparison "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
