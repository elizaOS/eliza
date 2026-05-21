#!/usr/bin/env python3
"""Validate AlphaChip-successor reproduction evidence manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT
    / "build/ai_eda/alphachip_successor_reproduction/validation/alphachip_successor_reproduction.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.alphachip_successor_reproduction.v1"
EXPECTED_CLAIM_BOUNDARY = "alphachip_successor_reproduction_evidence_only_no_release_claim"


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


def validate_artifact(label: str, item: Any) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    status = item.get("status")
    if status not in {"PRESENT", "MISSING"}:
        return [f"{label}.status is invalid"]
    path_value = item.get("path")
    if status == "MISSING":
        return []
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    path = repo_path(path_value)
    errors: list[str] = []
    if not path.is_file():
        errors.append(f"{label}.path missing on disk")
    elif item.get("sha256") != sha256_file(path):
        errors.append(f"{label}.sha256 is stale")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    status = report.get("status")
    if status not in {"SUCCESSOR_REPRODUCTION_READY", "BLOCKED_REPRODUCTION_EVIDENCE"}:
        errors.append("unsupported status")
    ready = status == "SUCCESSOR_REPRODUCTION_READY"
    if report.get("optimization_claim_allowed") is not ready:
        errors.append("optimization_claim_allowed must match ready status")
    if report.get("reproduction_claim_allowed") is not ready:
        errors.append("reproduction_claim_allowed must match ready status")
    if int(report.get("minimum_cuda_epochs", 0)) < 200:
        errors.append("minimum_cuda_epochs must be at least 200")

    run_ids = report.get("evidence_run_ids")
    if not isinstance(run_ids, dict):
        errors.append("evidence_run_ids must be a mapping")
    else:
        for field in ("training_handoff", "full_training_matrix", "replay_comparison"):
            if not isinstance(run_ids.get(field), str) or not run_ids[field]:
                errors.append(f"evidence_run_ids.{field} must be non-empty")

    observed = report.get("observed")
    if not isinstance(observed, dict):
        errors.append("observed must be a mapping")
    else:
        if ready:
            if observed.get("training_device") != "cuda":
                errors.append("ready report must have CUDA training")
            if int(observed.get("training_epochs", 0)) < int(report.get("minimum_cuda_epochs", 200)):
                errors.append("ready report training_epochs is below threshold")
            if observed.get("inference_device") != "cuda":
                errors.append("ready report must have CUDA inference")
            if int(observed.get("candidate_count", 0)) <= 0:
                errors.append("ready report must have candidates")
            if int(observed.get("replay_queue_ready_count", 0)) <= 0:
                errors.append("ready report must have a ready replay queue item")
            if observed.get("full_training_matrix_status") != "MATRIX_READY_FOR_CUDA_HOST":
                errors.append("ready report must have ready full training matrix")
            if observed.get("replay_comparison_status") != "COMPARISON_READY":
                errors.append("ready report must have replay comparison ready")
        modes = observed.get("full_dataset_conversion_modes")
        if ready and (not isinstance(modes, dict) or not modes or not all(v is True for v in modes.values())):
            errors.append("ready report must have all full-dataset conversion modes")

    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, dict):
        errors.append("input_artifacts must be a mapping")
    else:
        for field in (
            "torch_training",
            "torch_inference",
            "trained_model",
            "training_metrics",
            "replay_queue",
            "full_training_matrix",
            "replay_comparison",
        ):
            errors.extend(validate_artifact(field, artifacts.get(field)))
        candidates = artifacts.get("candidate_manifests")
        if not isinstance(candidates, list):
            errors.append("candidate_manifests must be a list")
        else:
            for index, item in enumerate(candidates):
                errors.extend(validate_artifact(f"candidate_manifests[{index}]", item))
            if ready and not candidates:
                errors.append("ready report must hash candidate manifests")

    blockers = report.get("blockers")
    if ready and blockers:
        errors.append("ready report must not list blockers")
    if not ready and (not isinstance(blockers, list) or not blockers):
        errors.append("blocked report must list blockers")
    if isinstance(blockers, list):
        for index, blocker in enumerate(blockers):
            if not isinstance(blocker, str) or not blocker:
                errors.append(f"blockers[{index}] must be non-empty string")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or len(gates) < 3:
        errors.append("next_required_gates must be concrete")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.alphachip_successor_reproduction missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.alphachip_successor_reproduction {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.alphachip_successor_reproduction {error}")
        return 1
    status = "PASS" if report["status"] == "SUCCESSOR_REPRODUCTION_READY" else "PASS_WITH_BLOCKERS"
    print(
        "STATUS: "
        f"{status} ai_eda.alphachip_successor_reproduction "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
