#!/usr/bin/env python3
"""Validate deterministic macro-placement baseline/proxy candidate reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/macro_placement_policy/validation/macro_placement_baseline_report.json"
)
CLAIM_BOUNDARY = "macro_placement_baseline_only_no_openroad_replay_or_release_claim"
REQUIRED_POLICIES = {
    "center_legal_baseline",
    "target_aware_grid",
    "target_repair_search",
    "circuit_training_proxy",
    "simulated_annealing_proxy",
    "hier_rtlmp_proxy",
    "chipdiffusion_proxy",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_score(score: Any, label: str) -> list[str]:
    if not isinstance(score, dict):
        return [f"{label}: score must be a mapping"]
    errors: list[str] = []
    if score.get("proxy") != (
        "target_distance_when_labels_exist_else_center_distance_lower_is_better_"
        "with_overlap_boundary_penalties_no_wirelength_or_timing_claim"
    ):
        errors.append(f"{label}: unexpected proxy score basis")
    for field in ("movable_count", "target_label_count", "overlap_count", "out_of_bounds_count"):
        if not isinstance(score.get(field), int) or score[field] < 0:
            errors.append(f"{label}: score.{field} must be a non-negative integer")
    if not finite_number(score.get("target_label_coverage")):
        errors.append(f"{label}: score.target_label_coverage must be numeric")
    if score.get("score") is not None and not finite_number(score.get("score")):
        errors.append(f"{label}: score.score must be numeric or null")
    overlap_status = score.get("overlap_check_status")
    if overlap_status is not None and overlap_status not in {
        "exact_pairwise",
        "skipped_large_case_pre_replay_guarded_by_openroad",
    }:
        errors.append(f"{label}: unexpected overlap_check_status {overlap_status!r}")
    if overlap_status in {None, "exact_pairwise"}:
        for field in ("overlap_area_um2", "worst_overlap_area_um2"):
            if not finite_number(score.get(field)):
                errors.append(
                    f"{label}: score.{field} must be numeric when exact overlap is checked"
                )
    return errors


def validate_candidate(path: Path, expected_policy: str, expected_case_id: str) -> list[str]:
    errors: list[str] = []
    if not path.is_file():
        return [f"{rel(path)}: candidate file missing"]
    candidate = load_json(path)
    candidate_id = str(candidate.get("id", rel(path)))
    if candidate.get("schema") != "eda.e1_candidate.v1":
        errors.append(f"{candidate_id}: schema must be eda.e1_candidate.v1")
    if candidate.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{candidate_id}: claim_boundary mismatch")
    generated = candidate.get("generated_by")
    if not isinstance(generated, dict):
        errors.append(f"{candidate_id}: generated_by must be a mapping")
    else:
        if generated.get("policy") != expected_policy:
            errors.append(f"{candidate_id}: generated_by.policy mismatch")
        if generated.get("source") != "scripts/ai_eda/train_macro_placement_policy.py":
            errors.append(f"{candidate_id}: generated_by.source mismatch")
        errors.extend(validate_score(generated.get("score"), candidate_id))
    changes = candidate.get("proposed_changes")
    if not isinstance(changes, list) or not changes:
        errors.append(f"{candidate_id}: proposed_changes must be non-empty")
    ladder = candidate.get("validation_ladder")
    if not isinstance(ladder, dict):
        errors.append(f"{candidate_id}: validation_ladder must be a mapping")
    else:
        required = (
            set(ladder.get("required_gates", []))
            if isinstance(ladder.get("required_gates"), list)
            else set()
        )
        completed = (
            set(ladder.get("completed_gates", []))
            if isinstance(ladder.get("completed_gates"), list)
            else set()
        )
        for gate in ("deterministic_openroad_replay", "timing_check", "drc_check", "human_review"):
            if gate not in required:
                errors.append(f"{candidate_id}: missing required gate {gate}")
        if completed != {"baseline_policy_generation"}:
            errors.append(
                f"{candidate_id}: completed gates must only include baseline_policy_generation"
            )
    decision = candidate.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "replayed_blocked":
        errors.append(f"{candidate_id}: decision must remain replayed_blocked")
    if expected_case_id not in candidate_id:
        errors.append(f"{candidate_id}: candidate id does not include case id {expected_case_id}")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_placement_baseline_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("status") not in {"PASS", "PASS_WITH_BLOCKED_CASES"}:
        errors.append(f"unexpected report status {report.get('status')!r}")
    for field in ("case_count", "candidate_count", "blocked_case_count"):
        if not isinstance(report.get(field), int) or report[field] < 0:
            errors.append(f"{field} must be a non-negative integer")
    candidates = report.get("candidates")
    comparisons = report.get("comparisons")
    if not isinstance(candidates, list) or not candidates:
        return errors + ["candidates must be a non-empty list"]
    if report.get("candidate_count") != len(candidates):
        errors.append("candidate_count does not match candidates length")
    if not isinstance(comparisons, list) or not comparisons:
        errors.append("comparisons must be non-empty")

    seen_ids: set[str] = set()
    policies_seen: set[str] = set()
    case_policy_seen: dict[str, set[str]] = {}
    for item in candidates:
        if not isinstance(item, dict):
            errors.append("candidate inventory entries must be mappings")
            continue
        candidate_id = item.get("id")
        if not isinstance(candidate_id, str) or not candidate_id:
            errors.append("candidate inventory entry missing id")
            continue
        if candidate_id in seen_ids:
            errors.append(f"{candidate_id}: duplicate candidate id")
        seen_ids.add(candidate_id)
        policy = item.get("policy")
        case_id = item.get("case_id")
        if not isinstance(policy, str) or policy not in REQUIRED_POLICIES:
            errors.append(f"{candidate_id}: unexpected policy {policy!r}")
            continue
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"{candidate_id}: missing case_id")
            continue
        policies_seen.add(policy)
        case_policy_seen.setdefault(case_id, set()).add(policy)
        path_value = item.get("path")
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{candidate_id}: missing path")
            continue
        errors.extend(validate_candidate(repo_path(path_value), policy, case_id))
        errors.extend(validate_score(item.get("score"), f"{candidate_id}: report score"))

    missing_policies = sorted(REQUIRED_POLICIES - policies_seen)
    if missing_policies:
        errors.append(f"missing policies: {', '.join(missing_policies)}")
    for case_id, policies in case_policy_seen.items():
        missing = sorted(REQUIRED_POLICIES - policies)
        if missing:
            errors.append(f"{case_id}: missing policy candidates {missing}")

    if isinstance(comparisons, list):
        for comparison in comparisons:
            if not isinstance(comparison, dict):
                errors.append("comparison entries must be mappings")
                continue
            case_id = comparison.get("case_id")
            policy_rows = comparison.get("policy_comparisons")
            if not isinstance(case_id, str) or not case_id:
                errors.append("comparison missing case_id")
            if not isinstance(policy_rows, list) or not policy_rows:
                errors.append(f"{case_id}: policy_comparisons must be non-empty")
                continue
            row_policies = {row.get("policy") for row in policy_rows if isinstance(row, dict)}
            missing = sorted(REQUIRED_POLICIES - row_policies)
            if missing:
                errors.append(f"{case_id}: comparison missing policies {missing}")

    next_gates = report.get("next_required_gates")
    if not isinstance(next_gates, list) or not any(
        "OpenLane/OpenROAD" in str(gate) for gate in next_gates
    ):
        errors.append("next_required_gates must include OpenLane/OpenROAD replay")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = args.report.resolve()
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.macro_placement_baseline missing_report {report_path}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_baseline {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_baseline {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_baseline "
        f"cases={report['case_count']} candidates={report['candidate_count']} "
        f"blocked={report['blocked_case_count']} policies={len(REQUIRED_POLICIES)} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
