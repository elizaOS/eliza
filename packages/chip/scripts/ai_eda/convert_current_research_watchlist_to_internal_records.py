#!/usr/bin/env python3
"""Convert the current AI-EDA research watchlist into text instruction records."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WATCHLIST = (
    ROOT
    / "research/alpha_chip_macro_placement/01_sources/ai_eda_current_research_watchlist_2026.yaml"
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/current_research_watchlist_records"
CLAIM_BOUNDARY = "current_research_watchlist_text_sample_only_no_import_training_inference_e1_or_release_claim"


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
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def source_record(path: Path, row_index: int) -> dict[str, Any]:
    return {"path": rel(path), "sha256": sha256_file(path), "row_index": row_index}


def make_record(entry: dict[str, Any], watchlist_path: Path, row_index: int) -> dict[str, Any]:
    entry_id = str(entry["id"])
    return {
        "schema": "eda.text_instruction_sample.v1",
        "id": f"{entry_id}.current-research-watchlist.{row_index:06d}",
        "asset_id": entry_id,
        "source": source_record(watchlist_path, row_index),
        "split": "train",
        "task_type": "ai_eda_current_research_watchlist_intake",
        "prompt": (
            "Summarize the E1 AI-EDA intake plan, blockers, and evidence gates "
            f"for the current research method {entry.get('name')}."
        ),
        "response": {
            "kind": "structured_current_research_watchlist_intake",
            "content": {
                "id": entry_id,
                "name": entry.get("name"),
                "year": entry.get("year"),
                "lane": entry.get("lane"),
                "priority": entry.get("priority"),
                "source_url": entry.get("source_url"),
                "public_code_status": entry.get("public_code_status"),
                "e1_action": entry.get("e1_action"),
                "required_evidence": entry.get("required_evidence"),
                "blocked_by": [
                    "metadata-only current-research intake",
                    "license/provenance review before code or data import",
                    "no model, VLM, coding-agent, or external tool execution from this record",
                    "deterministic E1 replay and signoff evidence required before any optimization claim",
                ],
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py",
            "source_revision": f"{watchlist_path.name}:{sha256_file(watchlist_path)}",
        },
        "replay": {
            "deterministic_command": (
                "python3 scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py "
                "--run-id <run-id>"
            ),
            "expected_report": "build/ai_eda/current_research_watchlist_records/<run-id>/conversion_report.json",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watchlist = load_yaml(args.watchlist)
    entries = watchlist.get("entries")
    if not isinstance(entries, list) or not entries:
        raise SystemExit("watchlist entries must be a non-empty list")

    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    converted: list[dict[str, Any]] = []
    for row_index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise SystemExit(f"invalid watchlist entry at index {row_index}")
        record = make_record(entry, args.watchlist, row_index)
        path = out_dir / f"{record['id']}.json"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        converted.append(
            {
                "id": record["id"],
                "asset_id": record["asset_id"],
                "schema": record["schema"],
                "json": rel(path),
                "task_type": record["task_type"],
            }
        )

    report = {
        "schema": "eliza.ai_eda.current_research_watchlist_records_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "watchlist": source_record(args.watchlist, 0),
        "claim_boundary": CLAIM_BOUNDARY,
        "converted_record_count": len(converted),
        "converted_records": converted,
        "policy": {
            "metadata_only": True,
            "imports_code": False,
            "downloads_assets": False,
            "executes_research_code": False,
            "runs_model": False,
            "trains_model": False,
            "runs_inference": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_optimization_claims": True,
        },
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.current_research_watchlist_records "
        f"records={len(converted)} report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
