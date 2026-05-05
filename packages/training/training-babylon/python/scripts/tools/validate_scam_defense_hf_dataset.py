#!/usr/bin/env python3
"""
Validate the local HF-ready scam-defense dataset repo.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

# assemble_scam_defense_hf_dataset lives in data-prep/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "data-prep"))

from assemble_scam_defense_hf_dataset import (
    BENIGN_CATEGORY_LABELS,
    REQUIRED_COLUMNS,
    SPECIALIZED_THREAT_CATEGORIES,
    read_json,
    write_json,
)
from scam_defense_exchange import transcript_messages_from_prompt

LOGGER = logging.getLogger(__name__)
JSON_STRING_COLUMNS = (
    "messages_json",
    "available_actions_json",
    "private_analysis_json",
    "metadata_json",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a local scam-defense HF dataset repo.")
    parser.add_argument("--dataset-dir", required=True, help="Path to the assembled dataset repo.")
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path for a validation report JSON file.",
    )
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )


def parquet_files_by_split(dataset_dir: Path) -> dict[str, list[str]]:
    data_root = dataset_dir / "data"
    mapping: dict[str, list[str]] = {}
    for split_dir in sorted(path for path in data_root.iterdir() if path.is_dir()):
        parquet_files = sorted(str(path) for path in split_dir.glob("*.parquet"))
        if parquet_files:
            mapping[split_dir.name] = parquet_files
    return mapping


def validate_readme_config_paths(
    readme_front_matter: dict[str, Any],
    expected_split_paths: dict[str, str],
) -> dict[str, str]:
    configs = readme_front_matter.get("configs")
    if not isinstance(configs, list) or len(configs) != 1:
        raise ValueError("README configs front matter must contain exactly one default config")

    config_entry = configs[0]
    if not isinstance(config_entry, dict) or config_entry.get("config_name") != "default":
        raise ValueError("README default config is missing or malformed")

    data_files = config_entry.get("data_files")
    if not isinstance(data_files, list):
        raise ValueError("README config data_files is missing or malformed")

    readme_split_paths: dict[str, str] = {}
    for entry in data_files:
        if not isinstance(entry, dict):
            raise ValueError("README data_files entries must be objects")
        split_name = entry.get("split")
        path_pattern = entry.get("path")
        if not isinstance(split_name, str) or not isinstance(path_pattern, str):
            raise ValueError("README data_files entries must contain split and path strings")
        readme_split_paths[split_name] = path_pattern

    if readme_split_paths != expected_split_paths:
        raise ValueError(
            f"README data_files do not match expected Parquet paths: {readme_split_paths} != {expected_split_paths}"
        )
    return readme_split_paths


def validate_row_labels(row: dict[str, Any], record_id: str) -> None:
    if not str(row["origin_tag"]).strip():
        raise ValueError(f"Row {record_id} has an empty origin_tag")
    if not str(row["source_pool"]).strip():
        raise ValueError(f"Row {record_id} has an empty source_pool")
    if not str(row["assistant_response"]).strip():
        raise ValueError(f"Row {record_id} has an empty assistant_response")
    if str(row["category"]).lower() in BENIGN_CATEGORY_LABELS and bool(row["is_scam"]):
        raise ValueError(f"Row {record_id} is benign-labeled but marked as scam")
    if bool(row["is_scam"]) and str(row["label"]) != "scam":
        raise ValueError(f"Row {record_id} has inconsistent scam label")
    if not bool(row["is_scam"]) and str(row["label"]) != "not_scam":
        raise ValueError(f"Row {record_id} has inconsistent non-scam label")
    for column_name in ("style_variant", "conversation_start_mode", "admin_metadata_style"):
        if not str(row[column_name]).strip():
            raise ValueError(f"Row {record_id} has an empty {column_name}")
    category = str(row["category"]).lower()
    threat_family = str(row["threat_family"]).lower()
    if category in SPECIALIZED_THREAT_CATEGORIES and threat_family != category:
        raise ValueError(
            f"Row {record_id} has specialized category {category} but mismatched threat_family {threat_family}"
        )
    for evidence_entry in row.get("evidence") or []:
        lowered = str(evidence_entry).lower()
        if lowered.startswith('"name":') or lowered.startswith('"description":'):
            raise ValueError(
                f"Row {record_id} has catalog boilerplate in evidence: {evidence_entry}"
            )


def validate_json_columns(row: dict[str, Any]) -> None:
    for column_name in JSON_STRING_COLUMNS:
        json.loads(str(row[column_name]))


def non_system_turn_count(messages: list[dict[str, Any]]) -> int:
    return sum(1 for message in messages if str(message.get("role") or "") != "system")


def validate_private_analysis_alignment(row: dict[str, Any], record_id: str) -> None:
    private_analysis = json.loads(str(row["private_analysis_json"]))
    threat_family = str(row["threat_family"]).lower()
    private_threat_family = str(private_analysis.get("threatFamily") or "").lower()
    if threat_family != private_threat_family:
        raise ValueError(
            f"Row {record_id} has mismatched threat_family values: row={threat_family}, private_analysis={private_threat_family}"
        )
    if list(row.get("evidence") or []) != list(private_analysis.get("evidence") or []):
        raise ValueError(f"Row {record_id} has evidence that diverges from private_analysis_json")
    if list(row.get("risk_signals") or []) != list(private_analysis.get("riskSignals") or []):
        raise ValueError(
            f"Row {record_id} has risk_signals that diverge from private_analysis_json"
        )


def parse_readme_front_matter(readme_path: Path) -> dict[str, Any]:
    content = readme_path.read_text(encoding="utf-8")
    if not content.startswith("---\n"):
        raise ValueError(f"README is missing YAML front matter: {readme_path}")
    _, remainder = content.split("---\n", 1)
    if "\n---\n" not in remainder:
        raise ValueError(f"README front matter is not closed properly: {readme_path}")
    front_matter, _ = remainder.split("\n---\n", 1)
    parsed = yaml.safe_load(front_matter)
    if not isinstance(parsed, dict):
        raise ValueError(f"README front matter did not parse to an object: {readme_path}")
    return parsed


def load_dataset_splits(dataset_dir: Path) -> dict[str, Any]:
    from datasets import load_dataset

    data_files = parquet_files_by_split(dataset_dir)
    if not data_files:
        raise FileNotFoundError(f"No Parquet files found under {dataset_dir / 'data'}")
    return load_dataset("parquet", data_files=data_files)


def validate_dataset(dataset_dir: Path) -> dict[str, Any]:
    manifest_path = dataset_dir / "metadata" / "assembly_manifest.json"
    readme_path = dataset_dir / "README.md"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing assembly manifest: {manifest_path}")
    if not readme_path.exists():
        raise FileNotFoundError(f"Missing dataset README: {readme_path}")

    manifest = read_json(manifest_path)
    readme_front_matter = parse_readme_front_matter(readme_path)
    dataset = load_dataset_splits(dataset_dir)
    split_counts = {split_name: len(split_data) for split_name, split_data in dataset.items()}
    row_count = 0
    seen_record_ids: set[str] = set()
    duplicate_record_ids: set[str] = set()
    split_keys_by_split: dict[str, set[str]] = {split_name: set() for split_name in dataset}
    split_owner: dict[str, str] = {}
    overlapping_split_keys: dict[str, set[str]] = {}
    origin_counts: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    category_counts_by_split: dict[str, Counter[str]] = {
        split_name: Counter() for split_name in dataset
    }
    message_turn_counts: list[int] = []

    for split_name, split_data in dataset.items():
        column_names = set(split_data.column_names)
        missing = REQUIRED_COLUMNS - column_names
        if missing:
            raise ValueError(f"Split {split_name} is missing required columns: {sorted(missing)}")
        for row in split_data:
            row_count += 1
            record_id = str(row["record_id"])
            if record_id in seen_record_ids:
                duplicate_record_ids.add(record_id)
            seen_record_ids.add(record_id)
            split_key = str(row["split_key"])
            owner_split = split_owner.get(split_key)
            if owner_split is not None and owner_split != split_name:
                overlapping_split_keys.setdefault(split_key, {owner_split}).add(split_name)
            else:
                split_owner[split_key] = split_name
            split_keys_by_split[split_name].add(split_key)
            origin_counts[str(row["origin_tag"])] += 1
            category_counts[str(row["category"])] += 1
            category_counts_by_split[split_name][str(row["category"])] += 1
            validate_row_labels(row, record_id)
            validate_json_columns(row)
            validate_private_analysis_alignment(row, record_id)
            parsed_messages = json.loads(str(row["messages_json"]))
            if not isinstance(parsed_messages, list):
                raise ValueError(f"Row {record_id} has non-list messages_json")
            turn_count = non_system_turn_count(parsed_messages)
            message_turn_counts.append(turn_count)
            transcript_messages = transcript_messages_from_prompt(str(row["user_prompt"]))
            if len(transcript_messages) >= 2 and turn_count <= 2:
                raise ValueError(
                    f"Row {record_id} contains transcript history but messages_json only has {turn_count} non-system turns"
                )

    if duplicate_record_ids:
        raise ValueError(f"Duplicate record_ids across splits: {sorted(duplicate_record_ids)[:10]}")
    if overlapping_split_keys:
        sample = {key: sorted(value) for key, value in list(overlapping_split_keys.items())[:10]}
        raise ValueError(f"Split-key leakage detected: {sample}")
    missing_train_categories = sorted(
        category
        for category, count in category_counts.items()
        if count > 0 and category_counts_by_split.get("train", Counter()).get(category, 0) == 0
    )
    if missing_train_categories:
        raise ValueError(f"Categories missing train coverage: {missing_train_categories}")

    manifest_split_counts = manifest.get("splitCounts") or {}
    normalized_split_counts = {
        split_name: split_counts.get(split_name, 0) for split_name in manifest_split_counts
    }
    for split_name, count in split_counts.items():
        normalized_split_counts.setdefault(split_name, count)
    if manifest_split_counts != normalized_split_counts:
        raise ValueError(
            "Manifest split counts do not match Parquet rows: "
            f"manifest={manifest_split_counts}, actual={normalized_split_counts}"
        )

    expected_split_paths = {
        split_name: f"data/{split_name}/*.parquet" for split_name in manifest_split_counts
    }
    readme_split_paths = validate_readme_config_paths(
        readme_front_matter,
        expected_split_paths,
    )

    report = {
        "status": "pass",
        "datasetDir": str(dataset_dir),
        "generatedAt": manifest.get("generatedAt"),
        "splitCounts": split_counts,
        "rowCount": row_count,
        "categoryCounts": dict(category_counts),
        "originCount": len(origin_counts),
        "trainCategoryCoverage": dict(category_counts_by_split.get("train", Counter())),
        "messagesTurnStats": {
            "minNonSystemTurns": min(message_turn_counts) if message_turn_counts else 0,
            "maxNonSystemTurns": max(message_turn_counts) if message_turn_counts else 0,
        },
        "splitGroupCounts": {
            split_name: len(split_keys) for split_name, split_keys in split_keys_by_split.items()
        },
        "readmeSplitPaths": readme_split_paths,
        "requiredColumns": sorted(REQUIRED_COLUMNS),
    }
    return report


def main() -> int:
    args = parse_args()
    configure_logging(args.log_level)
    try:
        dataset_dir = Path(args.dataset_dir).resolve()
        report = validate_dataset(dataset_dir)
        if args.output:
            write_json(Path(args.output).resolve(), report)
        LOGGER.info(
            "Scam-defense HF dataset validation passed for %s with %d rows",
            dataset_dir,
            report["rowCount"],
        )
        return 0
    except Exception:
        LOGGER.exception("Scam-defense HF dataset validation failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
