#!/usr/bin/env python3
"""Validate generated E1 AI-EDA candidate manifests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATES = (
    ROOT / "docs/spec-db/ai-eda/examples/e1-candidate.example.yaml",
    ROOT / "build/ai_eda/training_runs/validation/candidate_manifest.json",
)
CLAIM_BOUNDARY = "candidate_manifest_validation_only_no_design_change_or_release_claim"


def load_record(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def validate_candidate(path: Path) -> list[str]:
    errors: list[str] = []
    if not path.exists():
        return [f"{path}: missing candidate manifest"]
    try:
        record = load_record(path)
    except Exception as exc:  # noqa: BLE001
        return [f"{path}: {exc}"]

    record_id = record.get("id", str(path))
    if record.get("schema") != "eda.e1_candidate.v1":
        errors.append(f"{record_id}: schema must be eda.e1_candidate.v1")
    for field in (
        "id",
        "candidate_type",
        "design_bundle_id",
        "generated_by",
        "proposed_changes",
        "validation_ladder",
        "decision",
        "claim_boundary",
    ):
        if field not in record:
            errors.append(f"{record_id}: missing required field {field}")

    generated_by = record.get("generated_by")
    if not isinstance(generated_by, dict):
        errors.append(f"{record_id}: generated_by must be a mapping")
    else:
        if not generated_by.get("source"):
            errors.append(f"{record_id}: generated_by.source is required")
        if not generated_by.get("model_or_tool"):
            errors.append(f"{record_id}: generated_by.model_or_tool is required")

    proposed = record.get("proposed_changes")
    if not isinstance(proposed, list) or not proposed:
        errors.append(f"{record_id}: proposed_changes must be a non-empty list")

    ladder = record.get("validation_ladder")
    if not isinstance(ladder, dict):
        errors.append(f"{record_id}: validation_ladder must be a mapping")
    else:
        required = ladder.get("required_gates")
        completed = ladder.get("completed_gates")
        if not isinstance(required, list) or not required:
            errors.append(f"{record_id}: validation_ladder.required_gates must be non-empty")
        if not isinstance(completed, list):
            errors.append(f"{record_id}: validation_ladder.completed_gates must be a list")
        if isinstance(completed, list) and "deterministic_openroad_replay" in completed:
            decision = record.get("decision", {})
            if isinstance(decision, dict) and decision.get("status") != "accepted":
                errors.append(
                    f"{record_id}: deterministic replay completed but decision is not accepted"
                )

    decision = record.get("decision")
    if not isinstance(decision, dict):
        errors.append(f"{record_id}: decision must be a mapping")
    else:
        status = decision.get("status")
        if status == "accepted":
            ladder = record.get("validation_ladder", {})
            completed = ladder.get("completed_gates", []) if isinstance(ladder, dict) else []
            required = ladder.get("required_gates", []) if isinstance(ladder, dict) else []
            missing = sorted(set(required) - set(completed))
            if missing:
                errors.append(f"{record_id}: accepted candidate is missing gates {missing}")
        elif status not in {"BLOCKED_FIXTURE_ONLY", "replayed_blocked", "rejected", "pending"}:
            errors.append(f"{record_id}: unsupported decision.status {status!r}")

    claim_boundary = record.get("claim_boundary")
    if not isinstance(claim_boundary, str) or "release_claim" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must explicitly forbid release claims")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    candidates = args.candidate or list(DEFAULT_CANDIDATES)
    errors: list[str] = []
    for path in candidates:
        errors.extend(validate_candidate(path))
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.candidate_manifest {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.candidate_manifests "
        f"count={len(candidates)} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
