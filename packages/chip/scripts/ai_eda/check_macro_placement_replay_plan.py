#!/usr/bin/env python3
"""Validate macro-placement replay-plan reports and quarantined bundles."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/macro_placement_replay/validation/replay_plan.json"
CLAIM_BOUNDARY = "macro_placement_replay_plan_validation_only_no_openroad_execution_or_release_claim"
PLAN_CLAIM_BOUNDARY = "macro_placement_replay_plan_only_no_openroad_execution_or_release_claim"
ALLOWED_STATUSES = {
    "READY_FOR_DETERMINISTIC_REPLAY",
    "BLOCKED_REPLAY_PLAN_READY",
}


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
        raise ValueError(f"{path}: expected JSON object")
    return data


def cfg_move_count(path: Path) -> int:
    count = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        count += 1
    return count


def validate_plan(plan: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if plan.get("schema") != "eliza.ai_eda.macro_placement_replay_plan.v1":
        errors.append("schema must be eliza.ai_eda.macro_placement_replay_plan.v1")
    if plan.get("claim_boundary") != PLAN_CLAIM_BOUNDARY:
        errors.append("claim_boundary is missing or incorrect")
    if plan.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if plan.get("errors") not in ([], None):
        errors.append("report contains errors")

    plans = plan.get("plans")
    if not isinstance(plans, list) or not plans:
        errors.append("plans must be a non-empty list")
        return errors

    if plan.get("candidate_count") != len(plans):
        errors.append("candidate_count does not match plans length")
    ready_count = sum(1 for item in plans if item.get("status") == "READY_FOR_DETERMINISTIC_REPLAY")
    blocked_count = sum(1 for item in plans if str(item.get("status", "")).startswith("BLOCKED"))
    if plan.get("ready_count") != ready_count:
        errors.append("ready_count does not match plans")
    if plan.get("blocked_count") != blocked_count:
        errors.append("blocked_count does not match plans")

    seen: set[str] = set()
    for item in plans:
        if not isinstance(item, dict):
            errors.append("plan item must be a mapping")
            continue
        candidate_id = item.get("candidate_id")
        if not isinstance(candidate_id, str) or not candidate_id:
            errors.append("plan item missing candidate_id")
            continue
        if candidate_id in seen:
            errors.append(f"{candidate_id}: duplicate candidate_id")
        seen.add(candidate_id)
        status = item.get("status")
        if status not in ALLOWED_STATUSES:
            errors.append(f"{candidate_id}: unsupported status {status!r}")
        blockers = item.get("blockers")
        if status == "BLOCKED_REPLAY_PLAN_READY" and not blockers:
            errors.append(f"{candidate_id}: blocked plan must list blockers")
        if status == "READY_FOR_DETERMINISTIC_REPLAY" and blockers:
            errors.append(f"{candidate_id}: ready plan must not list blockers")

        candidate_path = repo_path(str(item.get("candidate_path", "")))
        placement_case_path = repo_path(str(item.get("placement_case_path", "")))
        for label, path, expected_hash in (
            ("candidate", candidate_path, item.get("candidate_sha256")),
            ("placement_case", placement_case_path, item.get("placement_case_sha256")),
        ):
            if not path.exists():
                errors.append(f"{candidate_id}: missing {label} path {rel(path)}")
            elif sha256_file(path) != expected_hash:
                errors.append(f"{candidate_id}: {label} sha256 mismatch")

        artifacts = item.get("artifacts")
        if not isinstance(artifacts, dict):
            errors.append(f"{candidate_id}: artifacts must be a mapping")
            continue
        macro_cfg = repo_path(str(artifacts.get("macro_placement_cfg", "")))
        overrides_path = repo_path(str(artifacts.get("placement_overrides", "")))
        bundle_dir = repo_path(str(artifacts.get("bundle_dir", "")))
        if not bundle_dir.exists() or not bundle_dir.is_dir():
            errors.append(f"{candidate_id}: missing bundle_dir")
        if not macro_cfg.exists():
            errors.append(f"{candidate_id}: missing macro_placement_cfg")
        if not overrides_path.exists():
            errors.append(f"{candidate_id}: missing placement_overrides")
            continue

        try:
            overrides = load_json(overrides_path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{candidate_id}: invalid placement_overrides: {exc}")
            continue
        if overrides.get("schema") != "eliza.ai_eda.macro_placement_overrides.v1":
            errors.append(f"{candidate_id}: placement_overrides schema mismatch")
        if overrides.get("claim_boundary") != PLAN_CLAIM_BOUNDARY:
            errors.append(f"{candidate_id}: placement_overrides claim_boundary mismatch")
        if overrides.get("candidate_id") != candidate_id:
            errors.append(f"{candidate_id}: placement_overrides candidate_id mismatch")
        overrides_list = overrides.get("overrides")
        if not isinstance(overrides_list, list) or not overrides_list:
            errors.append(f"{candidate_id}: placement_overrides.overrides must be non-empty")
        override_count = artifacts.get("override_count")
        if isinstance(overrides_list, list) and override_count != len(overrides_list):
            errors.append(f"{candidate_id}: override_count does not match overrides length")
        if macro_cfg.exists() and isinstance(override_count, int) and cfg_move_count(macro_cfg) != override_count:
            errors.append(f"{candidate_id}: macro_placement_cfg line count does not match override_count")

        tool_action = item.get("tool_action_manifest")
        if not isinstance(tool_action, str) or not repo_path(tool_action).exists():
            errors.append(f"{candidate_id}: missing tool_action_manifest")

        replay = item.get("deterministic_replay")
        if not isinstance(replay, dict):
            errors.append(f"{candidate_id}: deterministic_replay must be a mapping")
        else:
            for field in ("candidate_schema_check", "placement_case_replay_command", "expected_report", "next_openlane_step"):
                if not replay.get(field):
                    errors.append(f"{candidate_id}: deterministic_replay.{field} is required")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_plan missing_report {args.report}")
        return 1
    try:
        plan = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_plan {args.report}: {exc}")
        return 1
    errors = validate_plan(plan, args.report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_replay_plan {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_replay_plan "
        f"candidates={plan['candidate_count']} ready={plan['ready_count']} "
        f"blocked={plan['blocked_count']} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
