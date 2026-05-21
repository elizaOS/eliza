#!/usr/bin/env python3
"""Materialize tiny AI-EDA schema examples as JSON fixture records under build/."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES_DIR = ROOT / "docs/spec-db/ai-eda/examples"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/internal_dataset_fixtures"
CLAIM_BOUNDARY = "internal_dataset_fixture_materialization_only_no_training_inference_or_release_claim"


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected YAML mapping")
    return data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--examples-dir", type=Path, default=EXAMPLES_DIR)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    records_dir = out_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict[str, Any]] = []
    for source_path in sorted(args.examples_dir.glob("*.yaml")):
        record = load_yaml(source_path)
        record["materialized_from"] = str(source_path.relative_to(ROOT))
        record["fixture_claim_boundary"] = CLAIM_BOUNDARY
        out_path = records_dir / f"{record['id']}.json"
        out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        records.append(
            {
                "id": record["id"],
                "schema": record["schema"],
                "source": str(source_path.relative_to(ROOT)),
                "json": str(out_path.relative_to(ROOT)),
            }
        )

    report = {
        "schema": "eliza.ai_eda.internal_dataset_fixture_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "record_count": len(records),
        "records": records,
        "next_actions": [
            "Use these fixture records for converter, dataloader, and schema smoke tests.",
            "Do not use fixture labels for model quality claims.",
            "Replace fixture labels with deterministic E1 replay output before training.",
        ],
    }
    report_path = out_dir / "internal_dataset_fixture_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.internal_dataset_fixtures {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
