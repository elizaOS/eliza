#!/usr/bin/env python3
"""Validate full CUDA AI-EDA training/evaluation matrix manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/cuda_full_training_matrix/validation/cuda_full_training_matrix.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.cuda_full_training_matrix.v1"
EXPECTED_CLAIM_BOUNDARY = "cuda_full_training_matrix_only_no_training_or_release_claim"
REQUIRED_JOB_IDS = {
    "host_preflight",
    "asset_fetch_and_verify",
    "normalized_training_corpus",
    "floorplanning_dataset_readiness",
    "circuitnet3_timing_power_surrogate",
    "r_zoo_rectilinear_legality_baseline",
    "macro_placement_supervised_dataset",
    "alphachip_successor_cuda_train",
    "alphachip_successor_inference",
    "candidate_ranking_replay_queue",
    "openlane_replay_and_comparison",
    "logic_synthesis_policy_baseline",
    "verification_analysis_optimization_targets",
    "objective_readiness_closeout",
}
REQUIRED_FULL_DATASET_MODES = {
    "CircuitNet3",
    "ChiPBench-D",
    "OpenABC-D",
    "AIEDA iDATA",
    "EDALearn",
    "Macro Placement Challenge 2026",
    "R-Zoo Rectilinear Floorplan",
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
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_artifact(label: str, item: Any, allow_missing: bool) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    if item.get("status") not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    if item.get("status") == "MISSING" and not allow_missing:
        errors.append(f"{label} is required but missing")
    if item.get("status") == "PRESENT":
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
    return errors


def validate_job(index: int, job: Any) -> list[str]:
    if not isinstance(job, dict):
        return [f"jobs[{index}] must be a mapping"]
    errors: list[str] = []
    for field in ("id", "title", "lane", "command"):
        if not isinstance(job.get(field), str) or not job[field]:
            errors.append(f"jobs[{index}].{field} must be non-empty")
    for field in ("required_inputs", "expected_outputs", "acceptance_gates"):
        if not isinstance(job.get(field), list) or not job[field]:
            errors.append(f"jobs[{index}].{field} must be a non-empty list")
        elif any(not isinstance(item, str) or not item for item in job[field]):
            errors.append(f"jobs[{index}].{field} entries must be non-empty strings")
    if not isinstance(job.get("min_gpu_memory_gb"), int) or job["min_gpu_memory_gb"] < 0:
        errors.append(f"jobs[{index}].min_gpu_memory_gb must be a non-negative integer")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("large_training_claim_allowed") is not False:
        errors.append("large_training_claim_allowed must remain false")
    if report.get("status") not in {"MATRIX_READY_FOR_CUDA_HOST", "MATRIX_RECORDED_WITH_BLOCKERS"}:
        errors.append("unsupported status")
    evidence_run_ids = report.get("evidence_run_ids")
    if not isinstance(evidence_run_ids, dict):
        errors.append("evidence_run_ids must be a mapping")
    else:
        for field in ("payload", "preflight"):
            if not isinstance(evidence_run_ids.get(field), str) or not evidence_run_ids[field]:
                errors.append(f"evidence_run_ids.{field} must be non-empty")
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, dict):
        errors.append("input_artifacts must be a mapping")
    else:
        allow_missing = report.get("status") == "MATRIX_RECORDED_WITH_BLOCKERS"
        for name in ("cuda_run_plan", "cuda_preflight"):
            if name not in artifacts:
                errors.append(f"input_artifacts.{name} missing")
            else:
                errors.extend(validate_artifact(f"input_artifacts.{name}", artifacts[name], allow_missing))
    full_dataset_modes = report.get("full_dataset_conversion_modes")
    if not isinstance(full_dataset_modes, dict):
        errors.append("full_dataset_conversion_modes must be a mapping")
    else:
        missing_modes = sorted(REQUIRED_FULL_DATASET_MODES - set(full_dataset_modes))
        if missing_modes:
            errors.append(f"missing full-dataset modes: {', '.join(missing_modes)}")
        bad_values = [
            name
            for name, value in full_dataset_modes.items()
            if name in REQUIRED_FULL_DATASET_MODES and not isinstance(value, bool)
        ]
        if bad_values:
            errors.append(f"full-dataset mode values must be boolean: {', '.join(sorted(bad_values))}")
        if report.get("status") == "MATRIX_READY_FOR_CUDA_HOST" and not all(
            full_dataset_modes.get(name) is True for name in REQUIRED_FULL_DATASET_MODES
        ):
            errors.append("ready matrix requires every reviewed all-record conversion mode")
    jobs = report.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        return errors + ["jobs must be a non-empty list"]
    if report.get("job_count") != len(jobs):
        errors.append("job_count mismatch")
    ids = {job.get("id") for job in jobs if isinstance(job, dict)}
    missing = sorted(REQUIRED_JOB_IDS - ids)
    if missing:
        errors.append(f"missing jobs: {', '.join(missing)}")
    if len(ids) != len(jobs):
        errors.append("job ids must be unique and present")
    for index, item in enumerate(jobs):
        errors.extend(validate_job(index, item))
    blockers = report.get("blockers")
    if report.get("status") == "MATRIX_RECORDED_WITH_BLOCKERS" and not blockers:
        errors.append("blocked matrix must list blockers")
    if report.get("status") == "MATRIX_READY_FOR_CUDA_HOST" and blockers:
        errors.append("ready matrix must not list blockers")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or len(gates) < 4:
        errors.append("next_required_gates must be concrete")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.cuda_full_training_matrix missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.cuda_full_training_matrix {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cuda_full_training_matrix {error}")
        return 1
    status = "PASS" if report["status"] == "MATRIX_READY_FOR_CUDA_HOST" else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.cuda_full_training_matrix "
        f"status={report['status']} jobs={report['job_count']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
