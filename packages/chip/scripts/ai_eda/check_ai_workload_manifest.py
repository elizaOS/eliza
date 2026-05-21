#!/usr/bin/env python3
"""Validate the E1 AI workload/model manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "docs/spec-db/ai-eda/e1-ai-workload-manifest.yaml"
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
EXPECTED_SCHEMA = "eliza.ai_eda.ai_workload_manifest.v1"
EXPECTED_CLAIM_BOUNDARY = "ai_workload_manifest_only_no_benchmark_performance_or_release_claim"
REQUIRED_CATEGORIES = {
    "architecture_sim",
    "compiler_lowering",
    "dataflow_mapping",
    "quantization",
    "runtime_benchmark",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def benchmark_names() -> set[str]:
    data = json.loads(BENCHMARK_PLAN.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("benchmarks"), list):
        raise ValueError(f"{rel(BENCHMARK_PLAN)} has invalid benchmark list")
    return {
        str(item["name"])
        for item in data["benchmarks"]
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a mapping")
        return {}
    return value


def require_non_empty_str(mapping: dict[str, Any], key: str, label: str, errors: list[str]) -> None:
    if not isinstance(mapping.get(key), str) or not mapping[key]:
        errors.append(f"{label}.{key} must be a non-empty string")


def validate_artifacts(workload: dict[str, Any], label: str, errors: list[str]) -> None:
    artifacts = workload.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append(f"{label}.artifacts must be a non-empty list")
        return
    for index, artifact in enumerate(artifacts):
        artifact_label = f"{label}.artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{artifact_label} must be a mapping")
            continue
        require_non_empty_str(artifact, "path", artifact_label, errors)
        require_non_empty_str(artifact, "role", artifact_label, errors)
        path_value = artifact.get("path")
        if not isinstance(path_value, str) or not path_value:
            continue
        path = ROOT / path_value
        if not path.is_file():
            errors.append(f"{artifact_label}.path missing: {path_value}")
            continue
        expected_hash = artifact.get("sha256")
        if not isinstance(expected_hash, str) or len(expected_hash) != 64:
            errors.append(f"{artifact_label}.sha256 must be a 64-character string")
            continue
        actual_hash = sha256_file(path)
        if actual_hash != expected_hash:
            errors.append(
                f"{artifact_label}.sha256 mismatch for {path_value}: expected {expected_hash}, got {actual_hash}"
            )


def validate_workload(
    workload: Any,
    index: int,
    seen_ids: set[str],
    plan_names: set[str],
    categories: set[str],
    errors: list[str],
) -> None:
    label = f"workloads[{index}]"
    if not isinstance(workload, dict):
        errors.append(f"{label} must be a mapping")
        return
    for key in (
        "id",
        "category",
        "source",
        "license_status",
        "quantization",
        "runtime_path",
        "evidence_status",
    ):
        require_non_empty_str(workload, key, label, errors)
    workload_id = workload.get("id")
    if isinstance(workload_id, str):
        if workload_id in seen_ids:
            errors.append(f"{label}.id duplicate: {workload_id}")
        seen_ids.add(workload_id)
    category = workload.get("category")
    if isinstance(category, str):
        categories.add(category)
    benchmark_ref = workload.get("benchmark_plan_ref")
    if benchmark_ref is not None and benchmark_ref not in plan_names:
        errors.append(
            f"{label}.benchmark_plan_ref not found in benchmark_plan.json: {benchmark_ref}"
        )
    validate_artifacts(workload, label, errors)
    if not isinstance(workload.get("input_shape"), dict) or not workload["input_shape"]:
        errors.append(f"{label}.input_shape must be a non-empty mapping")
    for key in ("expected_ops", "fallback_ops", "blockers"):
        value = workload.get(key)
        if not isinstance(value, list):
            errors.append(f"{label}.{key} must be a list")
        elif key != "fallback_ops" and not value:
            errors.append(f"{label}.{key} must be non-empty")
        elif not all(isinstance(item, str) and item for item in value):
            errors.append(f"{label}.{key} must contain only non-empty strings")
    tolerance = require_mapping(
        workload.get("golden_output_tolerance"), f"{label}.golden_output_tolerance", errors
    )
    if tolerance:
        require_non_empty_str(tolerance, "kind", f"{label}.golden_output_tolerance", errors)
        if "max_abs_error" not in tolerance:
            errors.append(f"{label}.golden_output_tolerance.max_abs_error is required")
    if workload.get("requires_zero_fallback_proof") is True:
        blockers = workload.get("blockers")
        if not isinstance(blockers, list) or not any("proof" in str(item) for item in blockers):
            errors.append(f"{label} requires zero-fallback proof but has no proof blocker")


def validate(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if manifest.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    policy = require_mapping(manifest.get("policy"), "policy", errors)
    if policy:
        for field in (
            "release_use_allowed",
            "performance_claim_allowed",
            "fallback_ops_must_be_reported",
            "e1_npu_claim_requires_zero_fallback_proof",
            "calibrated_power_or_timing_required_for_tops_per_watt",
        ):
            if not isinstance(policy.get(field), bool):
                errors.append(f"policy.{field} must be boolean")
        if policy.get("release_use_allowed") is not False:
            errors.append("policy.release_use_allowed must be false")
        if policy.get("performance_claim_allowed") is not False:
            errors.append("policy.performance_claim_allowed must be false")
    workloads = manifest.get("workloads")
    if not isinstance(workloads, list) or len(workloads) < 6:
        return errors + ["workloads must contain at least six entries"]
    plan_names = benchmark_names()
    seen_ids: set[str] = set()
    categories: set[str] = set()
    for index, workload in enumerate(workloads):
        validate_workload(workload, index, seen_ids, plan_names, categories, errors)
    missing_categories = REQUIRED_CATEGORIES - categories
    if missing_categories:
        errors.append(
            f"missing required workload categories: {', '.join(sorted(missing_categories))}"
        )
    blocked_count = sum(
        1
        for workload in workloads
        if isinstance(workload, dict)
        and str(workload.get("evidence_status", "")).startswith("blocked")
    )
    if blocked_count < 2:
        errors.append("manifest must preserve at least two blocked workload lanes")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.manifest.is_file():
        print(f"STATUS: FAIL ai_eda.ai_workload_manifest missing {rel(args.manifest)}")
        return 1
    try:
        manifest = load_yaml(args.manifest)
        errors = validate(manifest)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.ai_workload_manifest {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.ai_workload_manifest {error}")
        return 1
    workloads = manifest["workloads"]
    categories = sorted({workload["category"] for workload in workloads})
    print(
        "STATUS: PASS ai_eda.ai_workload_manifest "
        f"workloads={len(workloads)} categories={','.join(categories)} claim_boundary={manifest['claim_boundary']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
