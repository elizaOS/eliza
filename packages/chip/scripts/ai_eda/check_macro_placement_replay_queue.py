#!/usr/bin/env python3
"""Validate deterministic macro-placement replay queues."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/macro_placement_replay_queue/validation/replay_queue.json"
EXPECTED_SCHEMA = "eliza.ai_eda.macro_placement_replay_queue.v1"
EXPECTED_CLAIM_BOUNDARY = "macro_placement_replay_queue_only_no_openroad_execution_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def check_hashed_path(errors: list[str], label: str, value: Any) -> None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a mapping")
        return
    path_value = value.get("path")
    digest = value.get("sha256")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}.path must be present")
        return
    path = repo_path(path_value)
    if not path.is_file():
        errors.append(f"{label}.path missing on disk: {path_value}")
        return
    if not isinstance(digest, str) or len(digest) != 64:
        errors.append(f"{label}.sha256 must be a 64-character digest")
    elif sha256_file(path) != digest:
        errors.append(f"{label}.sha256 is stale")


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    selection = report.get("selection")
    if not isinstance(selection, dict):
        errors.append("selection must be a mapping")
    else:
        for field in ("source_eval_report", "source_replay_plan"):
            path_value = selection.get(field)
            digest = selection.get(f"{field}_sha256")
            if not isinstance(path_value, str) or not path_value:
                errors.append(f"selection.{field} must be present")
                continue
            path = repo_path(path_value)
            if not path.is_file():
                errors.append(f"selection.{field} missing on disk")
            elif sha256_file(path) != digest:
                errors.append(f"selection.{field}_sha256 is stale")
        for field in ("per_case", "limit"):
            if not isinstance(selection.get(field), int) or selection[field] < 1:
                errors.append(f"selection.{field} must be a positive integer")
    queue = report.get("queue")
    if not isinstance(queue, list) or not queue:
        return errors + ["queue must be a non-empty list"]
    if report.get("queue_count") != len(queue):
        errors.append("queue_count does not match queue length")
    ready_count = sum(1 for item in queue if isinstance(item, dict) and item.get("ready_for_execution") is True)
    blocked_count = sum(1 for item in queue if isinstance(item, dict) and item.get("ready_for_execution") is not True)
    if report.get("ready_count") != ready_count:
        errors.append("ready_count does not match queue")
    if report.get("blocked_count") != blocked_count:
        errors.append("blocked_count does not match queue")
    if report.get("missing_from_replay") not in ([], None):
        errors.append("missing_from_replay must be empty")
    seen_ids: set[str] = set()
    previous_rank = 0
    for item in queue:
        if not isinstance(item, dict):
            errors.append("queue item must be a mapping")
            continue
        candidate_id = item.get("candidate_id")
        rank = item.get("rank")
        if not isinstance(candidate_id, str) or not candidate_id:
            errors.append("queue item missing candidate_id")
            continue
        if candidate_id in seen_ids:
            errors.append(f"{candidate_id}: duplicate candidate_id")
        seen_ids.add(candidate_id)
        if rank != previous_rank + 1:
            errors.append(f"{candidate_id}: ranks must be contiguous from 1")
        previous_rank = rank if isinstance(rank, int) else previous_rank
        status = item.get("status")
        if status not in {"READY_FOR_DETERMINISTIC_REPLAY", "BLOCKED_REPLAY_PLAN_READY"}:
            errors.append(f"{candidate_id}: unsupported replay status {status!r}")
        blockers = item.get("blockers")
        ready = item.get("ready_for_execution")
        if ready is True and blockers:
            errors.append(f"{candidate_id}: ready item must not list blockers")
        if ready is not True and (not isinstance(blockers, list) or not blockers):
            errors.append(f"{candidate_id}: blocked item must list blockers")
        check_hashed_path(errors, f"{candidate_id}.candidate", item.get("candidate"))
        check_hashed_path(errors, f"{candidate_id}.placement_case", item.get("placement_case"))
        artifacts = item.get("artifacts")
        if not isinstance(artifacts, dict):
            errors.append(f"{candidate_id}: artifacts must be a mapping")
        else:
            check_hashed_path(
                errors,
                f"{candidate_id}.macro_placement_cfg",
                {
                    "path": artifacts.get("macro_placement_cfg"),
                    "sha256": artifacts.get("macro_placement_cfg_sha256"),
                },
            )
            check_hashed_path(
                errors,
                f"{candidate_id}.placement_overrides",
                {
                    "path": artifacts.get("placement_overrides"),
                    "sha256": artifacts.get("placement_overrides_sha256"),
                },
            )
            if not isinstance(artifacts.get("override_count"), int) or artifacts["override_count"] < 1:
                errors.append(f"{candidate_id}: artifacts.override_count must be positive")
        check_hashed_path(errors, f"{candidate_id}.tool_action_manifest", item.get("tool_action_manifest"))
        replay = item.get("deterministic_replay")
        if not isinstance(replay, dict) or not replay.get("candidate_schema_check"):
            errors.append(f"{candidate_id}: deterministic_replay must include candidate_schema_check")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or not any("OpenLane/OpenROAD" in str(gate) for gate in gates):
        errors.append("next_required_gates must mention OpenLane/OpenROAD replay")
    if report_path.name != "replay_queue.json":
        errors.append("report filename must be replay_queue.json")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_queue missing_report {rel(report_path)}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_queue {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_replay_queue {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_replay_queue "
        f"queue={report['queue_count']} ready={report['ready_count']} blocked={report['blocked_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
