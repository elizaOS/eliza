#!/usr/bin/env python3
"""Validate PyTorch macro-placement inference artifacts without importing torch."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/macro_placement_torch_inference/validation/torch_inference_run.json"
CLAIM_BOUNDARY = "macro_placement_torch_inference_only_no_openroad_replay_or_release_claim"
TRAINING_CLAIM_BOUNDARY = "macro_placement_torch_regressor_training_only_no_inference_replay_or_release_claim"


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
        raise ValueError(f"{path}: expected JSON object")
    return data


def validate_candidate(path: Path, report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    try:
        candidate = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return [f"{rel(path)}: failed to load candidate: {exc}"]
    candidate_id = candidate.get("id", rel(path))
    if candidate.get("schema") != "eda.e1_candidate.v1":
        errors.append(f"{candidate_id}: schema must be eda.e1_candidate.v1")
    if candidate.get("candidate_type") != "macro_placement":
        errors.append(f"{candidate_id}: candidate_type must be macro_placement")
    if candidate.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{candidate_id}: candidate claim_boundary is missing or incorrect")
    generated_by = candidate.get("generated_by")
    if not isinstance(generated_by, dict):
        errors.append(f"{candidate_id}: generated_by must be a mapping")
        return errors
    if generated_by.get("source") != "scripts/ai_eda/infer_macro_placement_torch_regressor.py":
        errors.append(f"{candidate_id}: generated_by.source must be torch inference script")
    if generated_by.get("model_or_tool") != report.get("model"):
        errors.append(f"{candidate_id}: generated_by.model_or_tool must match report model")
    geometry = generated_by.get("geometry")
    if not isinstance(geometry, dict):
        errors.append(f"{candidate_id}: generated_by.geometry must be a mapping")
    else:
        for field in ("unknown_target_count", "out_of_bounds_count", "overlap_count"):
            if geometry.get(field) != 0:
                errors.append(f"{candidate_id}: pre-replay geometry field {field} must be zero")
    proposed = candidate.get("proposed_changes")
    if not isinstance(proposed, list) or not proposed:
        errors.append(f"{candidate_id}: proposed_changes must be a non-empty list")
    ladder = candidate.get("validation_ladder")
    if not isinstance(ladder, dict):
        errors.append(f"{candidate_id}: validation_ladder must be a mapping")
    else:
        completed = ladder.get("completed_gates")
        if not isinstance(completed, list) or "torch_model_inference" not in completed:
            errors.append(f"{candidate_id}: completed_gates must include torch_model_inference")
    decision = candidate.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "replayed_blocked":
        errors.append(f"{candidate_id}: decision.status must remain replayed_blocked")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_placement_torch_inference_run.v1":
        errors.append("report schema must be eliza.ai_eda.macro_placement_torch_inference_run.v1")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("checkpoint_claim_boundary") != TRAINING_CLAIM_BOUNDARY:
        errors.append("checkpoint_claim_boundary must match torch regressor training boundary")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("device") not in {"cpu", "cuda", "mps"}:
        errors.append("report device must be cpu, cuda, or mps")

    model_path = repo_path(str(report.get("model", "")))
    if not model_path.exists():
        errors.append(f"missing model file: {rel(model_path)}")
    elif model_path.stat().st_size <= 0:
        errors.append(f"model file is empty: {rel(model_path)}")

    candidates = report.get("candidates")
    blocked_cases = report.get("blocked_cases")
    if not isinstance(candidates, list):
        errors.append("report candidates must be a list")
        candidates = []
    if not isinstance(blocked_cases, list):
        errors.append("report blocked_cases must be a list")
        blocked_cases = []
    if report.get("candidate_count") != len(candidates):
        errors.append("candidate_count does not match candidates length")
    if report.get("blocked_case_count") != len(blocked_cases):
        errors.append("blocked_case_count does not match blocked_cases length")

    seen: set[str] = set()
    reported_paths: list[Path] = []
    for item in candidates:
        if not isinstance(item, dict):
            errors.append("candidate inventory entries must be objects")
            continue
        candidate_id = item.get("id")
        if not isinstance(candidate_id, str) or not candidate_id:
            errors.append("candidate inventory entry missing id")
        elif candidate_id in seen:
            errors.append(f"{candidate_id}: duplicate candidate id")
        else:
            seen.add(candidate_id)
        candidate_path = repo_path(str(item.get("path", "")))
        if not candidate_path.exists():
            errors.append(f"missing candidate path: {rel(candidate_path)}")
            continue
        reported_paths.append(candidate_path)
        errors.extend(validate_candidate(candidate_path, report))

    candidate_dir = report_path.parent / "candidates"
    if candidate_dir.exists():
        actual_paths = sorted(path.resolve() for path in candidate_dir.glob("macro-placement-torch-regressor-*.json"))
        if sorted(reported_paths) != actual_paths:
            errors.append("candidate directory inventory does not match report.candidates")
    elif candidates:
        errors.append(f"missing candidate directory: {rel(candidate_dir)}")

    if not candidates and not blocked_cases:
        errors.append("inference report must contain candidates or blocked cases")
    if report_path.parent != ROOT and report.get("run_id") != report_path.parent.name:
        errors.append("report run_id must match report directory name")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.macro_placement_torch_inference missing_report {args.report}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_torch_inference {args.report}: {exc}")
        return 1
    errors = validate_report(report, args.report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_torch_inference {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_torch_inference "
        f"device={report['device']} candidates={report['candidate_count']} "
        f"blocked={report['blocked_case_count']} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
