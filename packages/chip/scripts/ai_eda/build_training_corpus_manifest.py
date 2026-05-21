#!/usr/bin/env python3
"""Build a unified manifest for normalized AI-EDA training/RAG records."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/training_corpus_manifest"
CLAIM_BOUNDARY = "training_corpus_manifest_only_no_payload_weights_training_or_e1_claim"

DATASETS = (
    {
        "id": "internal_dataset_fixtures",
        "records": "build/ai_eda/internal_dataset_fixtures/{run_id}/records",
        "report": "build/ai_eda/internal_dataset_fixtures/{run_id}/internal_dataset_fixture_report.json",
        "lane": "schema_fixture",
    },
    {
        "id": "tilos_macroplacement",
        "records": "build/ai_eda/tilos_macroplacement/{run_id}/records",
        "report": "build/ai_eda/tilos_macroplacement/{run_id}/conversion_report.json",
        "lane": "macro_placement",
    },
    {
        "id": "openroad_eda_corpus",
        "records": "build/ai_eda/openroad_eda_corpus/{run_id}/records",
        "jsonl": "build/ai_eda/openroad_eda_corpus/{run_id}/*.jsonl",
        "report": "build/ai_eda/openroad_eda_corpus/{run_id}/conversion_report.json",
        "lane": "eda_instruction_rag",
    },
    {
        "id": "circuitnet3",
        "records": "build/ai_eda/circuitnet3/{run_id}/records",
        "report": "build/ai_eda/circuitnet3/{run_id}/conversion_report.json",
        "lane": "timing_power_congestion",
    },
    {
        "id": "chipbench_d",
        "records": "build/ai_eda/chipbench_d/{run_id}/records",
        "report": "build/ai_eda/chipbench_d/{run_id}/conversion_report.json",
        "lane": "macro_placement",
    },
    {
        "id": "aieda_idata",
        "records": "build/ai_eda/aieda_idata/{run_id}/records",
        "report": "build/ai_eda/aieda_idata/{run_id}/conversion_report.json",
        "lane": "routing_congestion",
    },
    {
        "id": "edalearn",
        "records": "build/ai_eda/edalearn/{run_id}/records",
        "report": "build/ai_eda/edalearn/{run_id}/conversion_report.json",
        "lane": "rtl_config_qor",
    },
    {
        "id": "macro_place_challenge_2026",
        "records": "build/ai_eda/macro_place_challenge_2026/{run_id}/records",
        "report": "build/ai_eda/macro_place_challenge_2026/{run_id}/conversion_report.json",
        "lane": "macro_placement",
    },
    {
        "id": "mlcad_2023_fpga_macro",
        "records": "build/ai_eda/mlcad_2023_fpga_macro/{run_id}/records",
        "report": "build/ai_eda/mlcad_2023_fpga_macro/{run_id}/conversion_report.json",
        "lane": "fpga_macro_placement_transfer",
    },
    {
        "id": "research_code_assets",
        "records": "build/ai_eda/research_code_assets/{run_id}/records",
        "report": "build/ai_eda/research_code_assets/{run_id}/conversion_report.json",
        "lane": "research_rag",
    },
    {
        "id": "current_research_watchlist_records",
        "records": "build/ai_eda/current_research_watchlist_records/{run_id}/records",
        "report": "build/ai_eda/current_research_watchlist_records/{run_id}/conversion_report.json",
        "lane": "current_research_rag",
    },
    {
        "id": "openabc_d",
        "records": "build/ai_eda/openabc_d/{run_id}/records",
        "report": "build/ai_eda/openabc_d/{run_id}/conversion_report.json",
        "lane": "logic_synthesis",
    },
    {
        "id": "e1_softmacro_cases",
        "records": "build/ai_eda/e1_softmacro_cases/{run_id}/records",
        "report": "build/ai_eda/e1_softmacro_cases/{run_id}/materialization_report.json",
        "lane": "e1_macro_placement",
    },
    {
        "id": "converted_external_fixtures",
        "records": "build/ai_eda/converted_external_fixtures/{run_id}/records",
        "report": "build/ai_eda/converted_external_fixtures/{run_id}/conversion_report.json",
        "lane": "schema_fixture",
    },
    {
        "id": "e1_openlane_conversion",
        "records": "build/ai_eda/e1_openlane_conversion/{run_id}/records",
        "report": "build/ai_eda/e1_openlane_conversion/{run_id}/conversion-report.json",
        "lane": "e1_design_bundle",
    },
    {
        "id": "openlane_flow_labels",
        "records": "build/ai_eda/openlane_flow_labels/{run_id}/records",
        "report": "build/ai_eda/openlane_flow_labels/{run_id}/label-parse-report.json",
        "lane": "e1_flow_labels",
    },
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


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


def build_dataset_entry(spec: dict[str, str], run_id: str) -> dict[str, Any]:
    records_dir = ROOT / spec["records"].format(run_id=run_id)
    report_path = ROOT / spec["report"].format(run_id=run_id)
    record_paths = sorted(records_dir.glob("*.json")) if records_dir.is_dir() else []
    jsonl_paths = (
        sorted((ROOT / spec["jsonl"].format(run_id=run_id)).parent.glob(Path(spec["jsonl"]).name))
        if "jsonl" in spec
        else []
    )
    schema_counts: Counter[str] = Counter()
    claim_boundaries: Counter[str] = Counter()
    records: list[dict[str, Any]] = []
    for path in record_paths:
        record = load_json(path)
        schema = record.get("schema")
        record_id = record.get("id")
        claim_boundary = record.get("claim_boundary")
        schema_counts[str(schema)] += 1
        claim_boundaries[str(claim_boundary)] += 1
        records.append(
            {
                "id": record_id,
                "schema": schema,
                "path": rel(path),
                "sha256": sha256_file(path),
                "claim_boundary": claim_boundary,
            }
        )
    jsonl_files = [
        {
            "path": rel(path),
            "sha256": sha256_file(path),
            "line_count": count_jsonl(path),
        }
        for path in jsonl_paths
    ]
    logical_record_count = (
        sum(item["line_count"] for item in jsonl_files) if jsonl_files else len(records)
    )
    return {
        "id": spec["id"],
        "lane": spec["lane"],
        "records_dir": rel(records_dir),
        "records_dir_present": records_dir.is_dir(),
        "report": {
            "path": rel(report_path),
            "present": report_path.is_file(),
            "sha256": sha256_file(report_path) if report_path.is_file() else None,
        },
        "record_count": len(records),
        "logical_record_count": logical_record_count,
        "schema_counts": dict(sorted(schema_counts.items())),
        "claim_boundary_counts": dict(sorted(claim_boundaries.items())),
        "jsonl_files": jsonl_files,
        "records": records,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    datasets = [build_dataset_entry(spec, args.run_id) for spec in DATASETS]
    schema_counts: Counter[str] = Counter()
    lane_counts: Counter[str] = Counter()
    missing = []
    for dataset in datasets:
        lane_counts[dataset["lane"]] += int(dataset["record_count"])
        schema_counts.update(dataset["schema_counts"])
        if (
            not dataset["records_dir_present"]
            or not dataset["report"]["present"]
            or dataset["record_count"] == 0
        ):
            missing.append(dataset["id"])
    manifest = {
        "schema": "eliza.ai_eda.training_corpus_manifest.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "policy": {
            "manifest_only": True,
            "contains_dataset_payload": False,
            "contains_model_weights": False,
            "runs_training": False,
            "runs_inference": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_optimization_claims": True,
        },
        "dataset_count": len(datasets),
        "record_count": sum(dataset["record_count"] for dataset in datasets),
        "logical_record_count": sum(dataset["logical_record_count"] for dataset in datasets),
        "schema_counts": dict(sorted(schema_counts.items())),
        "lane_record_counts": dict(sorted(lane_counts.items())),
        "missing_or_empty_datasets": missing,
        "datasets": datasets,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "training_corpus_manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if missing:
        print(
            "STATUS: FAIL ai_eda.training_corpus_manifest "
            f"missing_or_empty={','.join(missing)} report={rel(out_path)}"
        )
        return 1
    print(
        "STATUS: PASS ai_eda.training_corpus_manifest "
        f"datasets={len(datasets)} records={manifest['record_count']} "
        f"logical_records={manifest['logical_record_count']} report={rel(out_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
