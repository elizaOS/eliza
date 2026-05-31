#!/usr/bin/env python3
"""Validate the unified AI-EDA training corpus manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = (
    ROOT / "build/ai_eda/training_corpus_manifest/validation/training_corpus_manifest.json"
)
CLAIM_BOUNDARY = "training_corpus_manifest_only_no_payload_weights_training_or_e1_claim"
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_optimization_claim_allowed",
    "e1_signoff_claim_allowed",
)
REQUIRED_DATASETS = {
    "internal_dataset_fixtures",
    "tilos_macroplacement",
    "openroad_eda_corpus",
    "circuitnet3",
    "chipbench_d",
    "aieda_idata",
    "edalearn",
    "macro_place_challenge_2026",
    "mlcad_2023_fpga_macro",
    "r_zoo_rectilinear_floorplan",
    "floorset_lite",
    "research_code_assets",
    "current_research_watchlist_records",
    "verireason_rtl_coder",
    "openabc_d",
    "e1_softmacro_cases",
    "converted_external_fixtures",
    "e1_openlane_conversion",
    "openlane_flow_labels",
}
REQUIRED_SCHEMAS = {
    "eda.design_bundle.v1",
    "eda.e1_candidate.v1",
    "eda.placement_case.v1",
    "eda.graph_sample.v1",
    "eda.flow_run.v1",
    "eda.text_instruction_sample.v1",
    "eda.tool_action.v1",
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
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def count_jsonl(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def validate_record_item(dataset_id: str, item: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    record_path = item.get("path")
    if not isinstance(record_path, str) or not record_path:
        return [f"{dataset_id}: record path must be non-empty"]
    path = repo_path(record_path)
    if not path.is_file():
        return [f"{dataset_id}: missing record {record_path}"]
    if item.get("sha256") != sha256_file(path):
        errors.append(f"{dataset_id}: stale sha256 for {record_path}")
    record = load_json(path)
    if record.get("id") != item.get("id"):
        errors.append(f"{dataset_id}: record id mismatch for {record_path}")
    if record.get("schema") != item.get("schema"):
        errors.append(f"{dataset_id}: schema mismatch for {record_path}")
    if record.get("claim_boundary") != item.get("claim_boundary"):
        errors.append(f"{dataset_id}: claim_boundary mismatch for {record_path}")
    if item.get("schema") not in REQUIRED_SCHEMAS:
        errors.append(f"{dataset_id}: unexpected schema {item.get('schema')!r}")
    return errors


def validate_jsonl_file(dataset_id: str, item: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    jsonl_path = item.get("path")
    if not isinstance(jsonl_path, str) or not jsonl_path:
        return [f"{dataset_id}: jsonl path must be non-empty"]
    path = repo_path(jsonl_path)
    if not path.is_file():
        return [f"{dataset_id}: missing jsonl file {jsonl_path}"]
    if item.get("sha256") != sha256_file(path):
        errors.append(f"{dataset_id}: stale sha256 for {jsonl_path}")
    line_count = item.get("line_count")
    if not isinstance(line_count, int) or line_count <= 0:
        errors.append(f"{dataset_id}: jsonl line_count must be positive for {jsonl_path}")
    elif line_count != count_jsonl(path):
        errors.append(f"{dataset_id}: stale jsonl line_count for {jsonl_path}")
    return errors


def validate_dataset(dataset: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    dataset_id = dataset.get("id")
    if not isinstance(dataset_id, str) or not dataset_id:
        return ["dataset id must be non-empty"]
    if dataset_id not in REQUIRED_DATASETS:
        errors.append(f"{dataset_id}: unexpected dataset id")
    if dataset.get("records_dir_present") is not True:
        errors.append(f"{dataset_id}: records_dir_present must be true")
    records = dataset.get("records")
    if not isinstance(records, list) or not records:
        errors.append(f"{dataset_id}: records must be non-empty")
    if dataset.get("record_count") != len(records or []):
        errors.append(f"{dataset_id}: record_count mismatch")
    jsonl_files = dataset.get("jsonl_files")
    if jsonl_files is None:
        jsonl_files = []
    if not isinstance(jsonl_files, list):
        errors.append(f"{dataset_id}: jsonl_files must be a list")
        jsonl_files = []
    report = dataset.get("report")
    report_data: dict[str, Any] | None = None
    if not isinstance(report, dict):
        errors.append(f"{dataset_id}: report must be a mapping")
    else:
        report_path = report.get("path")
        if report.get("present") is not True:
            errors.append(f"{dataset_id}: report.present must be true")
        elif not isinstance(report_path, str) or not repo_path(report_path).is_file():
            errors.append(f"{dataset_id}: report path missing")
        elif report.get("sha256") != sha256_file(repo_path(report_path)):
            errors.append(f"{dataset_id}: stale report sha256")
        else:
            report_data = load_json(repo_path(report_path))
    for item in records or []:
        if not isinstance(item, dict):
            errors.append(f"{dataset_id}: record item must be a mapping")
            continue
        errors.extend(validate_record_item(dataset_id, item))
    for item in jsonl_files:
        if not isinstance(item, dict):
            errors.append(f"{dataset_id}: jsonl item must be a mapping")
            continue
        errors.extend(validate_jsonl_file(dataset_id, item))
    logical_record_count = dataset.get("logical_record_count")
    expected_logical_count = sum(
        item.get("line_count", 0) for item in jsonl_files if isinstance(item, dict)
    ) or len(records or [])
    if logical_record_count != expected_logical_count:
        errors.append(f"{dataset_id}: logical_record_count mismatch")
    if dataset_id == "openroad_eda_corpus":
        if len(jsonl_files) != 3:
            errors.append("openroad_eda_corpus: expected train/val/test jsonl files")
        if report_data and logical_record_count != report_data.get("record_count"):
            errors.append(
                "openroad_eda_corpus: logical_record_count must match conversion report record_count"
            )
    schema_sum = (
        sum(dataset.get("schema_counts", {}).values())
        if isinstance(dataset.get("schema_counts"), dict)
        else -1
    )
    if schema_sum != dataset.get("record_count"):
        errors.append(f"{dataset_id}: schema_counts must sum to record_count")
    return errors


def validate_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema") != "eliza.ai_eda.training_corpus_manifest.v1":
        errors.append("schema mismatch")
    if manifest.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    for field in REQUIRED_FALSE_CLAIM_FLAGS:
        if manifest.get(field) is not False:
            errors.append(f"{field} must be false")
    if manifest.get("missing_or_empty_datasets") != []:
        errors.append("missing_or_empty_datasets must be empty")
    policy = manifest.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "contains_dataset_payload",
            "contains_model_weights",
            "runs_training",
            "runs_inference",
            "release_use_allowed",
            "e1_signoff_evidence",
            *REQUIRED_FALSE_CLAIM_FLAGS,
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in ("manifest_only", "deterministic_replay_required_for_optimization_claims"):
            if policy.get(field) is not True:
                errors.append(f"policy.{field} must be true")
    datasets = manifest.get("datasets")
    if not isinstance(datasets, list):
        return errors + ["datasets must be a list"]
    ids = [dataset.get("id") for dataset in datasets if isinstance(dataset, dict)]
    if set(ids) != REQUIRED_DATASETS:
        errors.append("datasets must match required training corpus set")
    if len(ids) != len(set(ids)):
        errors.append("dataset ids must be unique")
    if manifest.get("dataset_count") != len(datasets):
        errors.append("dataset_count mismatch")
    record_count = 0
    logical_record_count = 0
    schema_counts: dict[str, int] = {}
    for dataset in datasets:
        if not isinstance(dataset, dict):
            errors.append("dataset entries must be mappings")
            continue
        errors.extend(validate_dataset(dataset))
        record_count += int(dataset.get("record_count", 0))
        logical_record_count += int(dataset.get("logical_record_count", 0))
        for schema, count in dataset.get("schema_counts", {}).items():
            schema_counts[schema] = schema_counts.get(schema, 0) + int(count)
    if manifest.get("record_count") != record_count:
        errors.append("record_count mismatch")
    if manifest.get("logical_record_count") != logical_record_count:
        errors.append("logical_record_count mismatch")
    if manifest.get("schema_counts") != dict(sorted(schema_counts.items())):
        errors.append("schema_counts mismatch")
    missing_schemas = REQUIRED_SCHEMAS - set(schema_counts)
    if missing_schemas:
        errors.append(f"missing required schemas: {', '.join(sorted(missing_schemas))}")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = repo_path(str(args.manifest))
    if not manifest_path.is_file():
        print(f"STATUS: FAIL ai_eda.training_corpus_manifest missing_manifest {rel(manifest_path)}")
        return 1
    try:
        manifest = load_json(manifest_path)
        errors = validate_manifest(manifest)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.training_corpus_manifest {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.training_corpus_manifest {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.training_corpus_manifest "
        f"datasets={manifest['dataset_count']} records={manifest['record_count']} "
        f"logical_records={manifest['logical_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
