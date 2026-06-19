#!/usr/bin/env python3
"""Select a deterministic macro-placement replay queue from ranked candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUN_ID = "validation"
DEFAULT_EVAL_ROOT = ROOT / "build/ai_eda/macro_placement_full_candidate_eval"
DEFAULT_REPLAY_ROOT = ROOT / "build/ai_eda/macro_placement_full_replay"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_replay_queue"
CLAIM_BOUNDARY = "macro_placement_replay_queue_only_no_openroad_execution_or_release_claim"


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


def ranked_candidate_ids(eval_report: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for case in eval_report.get("ranked_by_case", []):
        if not isinstance(case, dict):
            continue
        for candidate in case.get("ranked_candidates", []):
            if not isinstance(candidate, dict):
                continue
            candidate_id = candidate.get("id")
            if isinstance(candidate_id, str) and candidate_id not in seen:
                seen.add(candidate_id)
                ids.append(candidate_id)
    return ids


def top_candidates_by_case(eval_report: dict[str, Any], per_case: int) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for case in eval_report.get("ranked_by_case", []):
        if not isinstance(case, dict):
            continue
        count = 0
        for candidate in case.get("ranked_candidates", []):
            if not isinstance(candidate, dict):
                continue
            candidate_id = candidate.get("id")
            if not isinstance(candidate_id, str) or candidate_id in seen:
                continue
            ids.append(candidate_id)
            seen.add(candidate_id)
            count += 1
            if count >= per_case:
                break
    return ids


def replay_plan_by_candidate(replay_report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    plans: dict[str, dict[str, Any]] = {}
    for plan in replay_report.get("plans", []):
        if isinstance(plan, dict) and isinstance(plan.get("candidate_id"), str):
            plans[plan["candidate_id"]] = plan
    return plans


def queue_item(plan: dict[str, Any], rank: int) -> dict[str, Any]:
    candidate_path = repo_path(str(plan["candidate_path"]))
    placement_case_path = repo_path(str(plan["placement_case_path"]))
    artifacts = plan.get("artifacts", {})
    macro_cfg = repo_path(str(artifacts.get("macro_placement_cfg", "")))
    overrides_path = repo_path(str(artifacts.get("placement_overrides", "")))
    tool_action_path = repo_path(str(plan.get("tool_action_manifest", "")))
    blockers = plan.get("blockers", [])
    return {
        "rank": rank,
        "candidate_id": plan["candidate_id"],
        "status": plan.get("status"),
        "ready_for_execution": plan.get("status") == "READY_FOR_DETERMINISTIC_REPLAY"
        and not blockers,
        "blockers": blockers if isinstance(blockers, list) else [],
        "design_bundle_id": plan.get("design_bundle_id"),
        "placement_case_id": plan.get("placement_case_id"),
        "candidate": {
            "path": rel(candidate_path),
            "sha256": sha256_file(candidate_path),
        },
        "placement_case": {
            "path": rel(placement_case_path),
            "sha256": sha256_file(placement_case_path),
        },
        "artifacts": {
            "bundle_dir": artifacts.get("bundle_dir"),
            "macro_placement_cfg": rel(macro_cfg),
            "macro_placement_cfg_sha256": sha256_file(macro_cfg),
            "placement_overrides": rel(overrides_path),
            "placement_overrides_sha256": sha256_file(overrides_path),
            "override_count": artifacts.get("override_count"),
        },
        "tool_action_manifest": {
            "path": rel(tool_action_path),
            "sha256": sha256_file(tool_action_path),
        },
        "deterministic_replay": plan.get("deterministic_replay", {}),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=DEFAULT_RUN_ID)
    parser.add_argument("--eval-report", type=Path)
    parser.add_argument("--replay-plan", type=Path)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--per-case", type=int, default=1)
    parser.add_argument("--limit", type=int, default=32)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.per_case < 1:
        raise SystemExit("--per-case must be >= 1")
    if args.limit < 1:
        raise SystemExit("--limit must be >= 1")
    eval_path = (
        args.eval_report
        or DEFAULT_EVAL_ROOT / args.run_id / "macro_placement_candidate_eval_report.json"
    )
    replay_path = args.replay_plan or DEFAULT_REPLAY_ROOT / args.run_id / "replay_plan.json"
    eval_report = load_json(eval_path)
    replay_report = load_json(replay_path)
    plans = replay_plan_by_candidate(replay_report)
    selected_ids = top_candidates_by_case(eval_report, args.per_case)
    if not selected_ids:
        selected_ids = ranked_candidate_ids(eval_report)
    queue: list[dict[str, Any]] = []
    missing_from_replay: list[str] = []
    for candidate_id in selected_ids:
        if len(queue) >= args.limit:
            break
        plan = plans.get(candidate_id)
        if plan is None:
            missing_from_replay.append(candidate_id)
            continue
        queue.append(queue_item(plan, len(queue) + 1))

    ready_count = sum(1 for item in queue if item["ready_for_execution"])
    blocked_count = sum(1 for item in queue if not item["ready_for_execution"])
    report = {
        "schema": "eliza.ai_eda.macro_placement_replay_queue.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "selection": {
            "per_case": args.per_case,
            "limit": args.limit,
            "source_eval_report": rel(repo_path(str(eval_path))),
            "source_eval_report_sha256": sha256_file(repo_path(str(eval_path))),
            "source_replay_plan": rel(repo_path(str(replay_path))),
            "source_replay_plan_sha256": sha256_file(repo_path(str(replay_path))),
        },
        "queue_count": len(queue),
        "ready_count": ready_count,
        "blocked_count": blocked_count,
        "missing_from_replay": missing_from_replay,
        "queue": queue,
        "next_required_gates": [
            "review this queue before executing any OpenLane/OpenROAD replay",
            "run replay only in an isolated run tree with pinned tool and PDK versions",
            "archive OpenLane/OpenROAD logs, generated reports, DEF/GDS, and manifest hashes",
            "compare replayed metrics against baseline before any source or config promotion",
        ],
        "release_use_allowed": False,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "replay_queue.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if missing_from_replay:
        print(
            "STATUS: FAIL ai_eda.macro_placement_replay_queue "
            f"missing_from_replay={','.join(missing_from_replay)} {rel(report_path)}"
        )
        return 1
    status = "PASS_WITH_BLOCKED_REPLAY" if blocked_count else "PASS"
    print(
        f"STATUS: {status} ai_eda.macro_placement_replay_queue "
        f"queue={len(queue)} ready={ready_count} blocked={blocked_count} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
