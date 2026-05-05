#!/usr/bin/env python3
"""
Verify that required prompt-injection datasets are present on disk, normalized into
canonical seeds, and propagated into agent-format training mixes.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parents[5]
DATASETS_ROOT = WORKSPACE_ROOT / "datasets"
SOURCE_ROOT = DATASETS_ROOT / "source" / "huggingface"
REGISTRY_PATH = DATASETS_ROOT / "manifests" / "source_registry.json"
CATALOG_PATH = DATASETS_ROOT / "manifests" / "source_catalog.json"
ANALYSIS_PATH = DATASETS_ROOT / "process" / "normalization-plan" / "analysis.json"
CANONICAL_ROOT = DATASETS_ROOT / "process" / "canonical-seeds"
FINAL_MIX_ROOT = DATASETS_ROOT / "final" / "corpus"

DEFAULT_DATASETS = (
    "deepset/prompt-injections",
    "xTRam1/safe-guard-prompt-injection",
    "neuralchemy/Prompt-injection-dataset",
    "rubend18/ChatGPT-Jailbreak-Prompts",
    "JailbreakBench/JBB-Behaviors",
    "hackaprompt/hackaprompt-dataset",
    "allenai/wildjailbreak",
    "IDA-SERICS/Disaster-tweet-jailbreaking",
)
REQUIRED_FORMAT_FILES = (
    "canonical.jsonl",
    "generic-chat.jsonl",
    "openai-chat.jsonl",
    "anthropic-messages.jsonl",
    "eliza-room.jsonl",
    "hermes-bridge.jsonl",
    "openclaw-session.jsonl",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    normalized = value.strip().strip("/").lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    return normalized


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def latest_manifest_dir(root: Path) -> Path:
    manifests = [(path.stat().st_mtime, path.parent) for path in root.glob("*/manifest.json")]
    if not manifests:
        raise FileNotFoundError(f"No manifest directories found under {root}")
    manifests.sort()
    return manifests[-1][1]


def latest_sweep_dir(root: Path) -> Path:
    summaries = [(path.stat().st_mtime, path.parent) for path in root.glob("*/sweep-summary.json")]
    if not summaries:
        raise FileNotFoundError(f"No sweep-summary.json files found under {root}")
    summaries.sort()
    return summaries[-1][1]


def file_stats(path: Path) -> dict[str, int]:
    file_count = 0
    size_bytes = 0
    for item in path.rglob("*"):
        if not item.is_file():
            continue
        file_count += 1
        size_bytes += item.stat().st_size
    return {"fileCount": file_count, "sizeBytes": size_bytes}


def load_registry_by_repo_id(path: Path) -> dict[str, dict[str, Any]]:
    registry = read_json(path)
    records = registry.get("records", [])
    return {str(record.get("repo_id") or record.get("name") or ""): record for record in records}


def load_catalog_repo_ids(path: Path) -> set[str]:
    catalog = read_json(path)
    return {
        str(record["repo_id"])
        for record in catalog.get("huggingface_datasets", [])
        if record.get("repo_id")
    }


def load_analysis_by_name(path: Path) -> dict[str, dict[str, Any]]:
    analysis = read_json(path)
    return {
        str(record["name"]): record for record in analysis.get("datasets", []) if record.get("name")
    }


def count_canonical_seeds(path: Path, datasets: set[str]) -> Counter[str]:
    counts: Counter[str] = Counter()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            dataset_name = str(row.get("sourceDataset") or "")
            if dataset_name in datasets:
                counts[dataset_name] += 1
    return counts


def source_dataset_from_record(row: dict[str, Any]) -> str:
    metadata = row.get("metadata")
    if isinstance(metadata, dict) and metadata.get("sourceDataset"):
        return str(metadata["sourceDataset"])
    for key in ("sourceDataset", "source_dataset"):
        value = row.get(key)
        if value:
            return str(value)
    return ""


def count_dataset_rows(jsonl_path: Path, datasets: set[str]) -> Counter[str]:
    counts: Counter[str] = Counter()
    with jsonl_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            dataset_name = source_dataset_from_record(row)
            if dataset_name in datasets:
                counts[dataset_name] += 1
    return counts


def mix_dirs(sweep_dir: Path) -> list[Path]:
    return sorted(
        path for path in sweep_dir.iterdir() if path.is_dir() and (path / "formats").exists()
    )


def best_mix_coverage(
    sweep_dir: Path,
    datasets: set[str],
) -> tuple[dict[str, int], Path | None, dict[str, int]]:
    coverage_by_dataset: dict[str, int] = {dataset: 0 for dataset in datasets}
    best_dir: Path | None = None
    best_counts: dict[str, int] = {}
    best_score = (-1, -1, "")

    for mix_dir in mix_dirs(sweep_dir):
        canonical_path = mix_dir / "formats" / "canonical.jsonl"
        if not canonical_path.exists():
            continue
        counts = dict(count_dataset_rows(canonical_path, datasets))
        for dataset_name, count in counts.items():
            if count > 0:
                coverage_by_dataset[dataset_name] += 1
        dataset_presence = sum(1 for dataset_name in datasets if counts.get(dataset_name, 0) > 0)
        total_rows = sum(counts.values())
        score = (dataset_presence, total_rows, mix_dir.name)
        if score > best_score:
            best_score = score
            best_dir = mix_dir
            best_counts = counts

    return coverage_by_dataset, best_dir, best_counts


def format_coverage_for_mix(
    mix_dir: Path,
    datasets: set[str],
    format_files: tuple[str, ...],
) -> dict[str, dict[str, int]]:
    coverage: dict[str, dict[str, int]] = {}
    for format_name in format_files:
        path = mix_dir / "formats" / format_name
        coverage[format_name] = dict(count_dataset_rows(path, datasets)) if path.exists() else {}
    return coverage


def build_report(
    *,
    datasets: list[str],
    source_root: Path,
    registry_path: Path,
    catalog_path: Path,
    analysis_path: Path,
    canonical_root: Path,
    final_mix_root: Path,
    format_files: tuple[str, ...] = REQUIRED_FORMAT_FILES,
) -> dict[str, Any]:
    dataset_set = set(datasets)
    registry_by_repo_id = load_registry_by_repo_id(registry_path)
    catalog_repo_ids = load_catalog_repo_ids(catalog_path)
    analysis_by_name = load_analysis_by_name(analysis_path)
    canonical_dir = latest_manifest_dir(canonical_root)
    canonical_counts = count_canonical_seeds(canonical_dir / "canonical-seeds.jsonl", dataset_set)
    sweep_dir = latest_sweep_dir(final_mix_root)
    coverage_by_dataset, best_mix_dir, best_mix_counts = best_mix_coverage(sweep_dir, dataset_set)
    best_mix_format_counts = (
        format_coverage_for_mix(best_mix_dir, dataset_set, format_files)
        if best_mix_dir is not None
        else {}
    )

    dataset_reports: dict[str, dict[str, Any]] = {}
    issues: list[str] = []

    for dataset_name in datasets:
        source_path = source_root / slugify(dataset_name)
        registry_record = registry_by_repo_id.get(dataset_name)
        analysis_record = analysis_by_name.get(dataset_name)
        best_mix_formats_ok = {
            format_name: best_mix_format_counts.get(format_name, {}).get(dataset_name, 0) > 0
            for format_name in format_files
        }

        report = {
            "dataset": dataset_name,
            "slug": slugify(dataset_name),
            "sourceCatalogPresent": dataset_name in catalog_repo_ids,
            "sourceRegistryStatus": registry_record.get("status") if registry_record else None,
            "sourceRegistryLocalPath": registry_record.get("local_path")
            if registry_record
            else None,
            "sourcePath": str(source_path),
            "sourcePathExists": source_path.exists(),
            "sourceStats": file_stats(source_path)
            if source_path.exists()
            else {"fileCount": 0, "sizeBytes": 0},
            "analysisPresent": analysis_record is not None,
            "analysisStatus": analysis_record.get("analysisStatus") if analysis_record else None,
            "analysisGroup": analysis_record.get("group") if analysis_record else None,
            "analysisTransformFamily": analysis_record.get("transformFamily")
            if analysis_record
            else None,
            "analysisTargetBehavior": analysis_record.get("targetBehavior")
            if analysis_record
            else None,
            "canonicalSeedCount": canonical_counts.get(dataset_name, 0),
            "mixPresenceCount": coverage_by_dataset.get(dataset_name, 0),
            "bestMixCanonicalCount": best_mix_counts.get(dataset_name, 0),
            "bestMixFormatCounts": {
                format_name: best_mix_format_counts.get(format_name, {}).get(dataset_name, 0)
                for format_name in format_files
            },
            "bestMixFormatCoverage": best_mix_formats_ok,
        }
        dataset_reports[dataset_name] = report

        if not report["sourceCatalogPresent"]:
            issues.append(f"{dataset_name}: missing from source catalog.")
        if report["sourceRegistryStatus"] != "downloaded":
            issues.append(f"{dataset_name}: source registry status is not downloaded.")
        if not report["sourcePathExists"]:
            issues.append(f"{dataset_name}: source path is missing.")
        if report["sourceStats"]["fileCount"] == 0:
            issues.append(f"{dataset_name}: source path has no retained files.")
        if not report["analysisPresent"]:
            issues.append(f"{dataset_name}: missing from normalization analysis.")
        elif report["analysisStatus"] != "ok":
            issues.append(
                f"{dataset_name}: normalization analysis status is {report['analysisStatus']}."
            )
        if report["canonicalSeedCount"] <= 0:
            issues.append(f"{dataset_name}: missing from latest canonical seeds.")
        if report["mixPresenceCount"] <= 0:
            issues.append(f"{dataset_name}: absent from latest final-train sweep.")
        for format_name, present in best_mix_formats_ok.items():
            if not present:
                issues.append(
                    f"{dataset_name}: absent from {format_name} in selected mix {best_mix_dir.name if best_mix_dir else 'none'}."
                )

    overall_status = "pass" if not issues else "fail"
    return {
        "generatedAt": now_iso(),
        "overallStatus": overall_status,
        "datasetsRoot": str(DATASETS_ROOT),
        "sourceRoot": str(source_root),
        "registryPath": str(registry_path),
        "catalogPath": str(catalog_path),
        "analysisPath": str(analysis_path),
        "latestCanonicalDir": str(canonical_dir),
        "latestFinalMixSweepDir": str(sweep_dir),
        "selectedMixDir": str(best_mix_dir) if best_mix_dir is not None else None,
        "selectedMixName": best_mix_dir.name if best_mix_dir is not None else None,
        "requiredDatasets": dataset_reports,
        "issues": issues,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify prompt-injection dataset coverage through the training pipeline."
    )
    parser.add_argument(
        "--dataset", action="append", default=None, help="Dataset repo id to require. Repeatable."
    )
    parser.add_argument("--output", default=None, help="Optional JSON output path.")
    parser.add_argument("--source-root", default=str(SOURCE_ROOT))
    parser.add_argument("--registry-path", default=str(REGISTRY_PATH))
    parser.add_argument("--catalog-path", default=str(CATALOG_PATH))
    parser.add_argument("--analysis-path", default=str(ANALYSIS_PATH))
    parser.add_argument("--canonical-root", default=str(CANONICAL_ROOT))
    parser.add_argument("--final-mix-root", default=str(FINAL_MIX_ROOT))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    datasets = list(dict.fromkeys(args.dataset or DEFAULT_DATASETS))
    report = build_report(
        datasets=datasets,
        source_root=Path(args.source_root),
        registry_path=Path(args.registry_path),
        catalog_path=Path(args.catalog_path),
        analysis_path=Path(args.analysis_path),
        canonical_root=Path(args.canonical_root),
        final_mix_root=Path(args.final_mix_root),
    )
    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["overallStatus"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
