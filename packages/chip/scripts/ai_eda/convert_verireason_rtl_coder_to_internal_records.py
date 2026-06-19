#!/usr/bin/env python3
"""Convert fetched VeriReason RTL-Coder datasets into internal text records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/verireason_rtl_coder"
CLAIM_BOUNDARY = "verireason_rtl_coder_text_sample_only_no_training_inference_e1_or_release_claim"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "training_claim_allowed": False,
    "inference_claim_allowed": False,
    "e1_signoff_claim_allowed": False,
    "rtl_generation_claim_allowed": False,
}

ASSETS = (
    {
        "id": "verireason-rtl-coder-small",
        "payload": "external/datasets/verireason-rtl-coder-small/payload",
        "files": (
            "randomized_filtered_data_7b.jsonl",
            "randomized_filtered_data_fixed.jsonl",
        ),
        "source_url": "https://huggingface.co/datasets/Nellyw888/RTL-Coder_small",
    },
    {
        "id": "verireason-rtl-coder-reasoning-simple",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-simple/payload",
        "files": ("processed_entries.jsonl",),
        "source_url": (
            "https://huggingface.co/datasets/Nellyw888/RTL-Coder_7b_reasoning_tb_simple"
        ),
    },
    {
        "id": "verireason-rtl-coder-reasoning-hard",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-hard/payload",
        "files": ("train_tb_filtered.jsonl",),
        "source_url": ("https://huggingface.co/datasets/Nellyw888/RTL-Coder_7b_reasoning_tb"),
    },
    {
        "id": "verireason-rtl-coder-reasoning-combined",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-combined/payload",
        "files": ("combined_dataset.jsonl",),
        "source_url": (
            "https://huggingface.co/datasets/Nellyw888/RTL-Coder_7b_reasoning_tb_combined"
        ),
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


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            if not line.strip():
                continue
            data = json.loads(line)
            if not isinstance(data, dict):
                raise ValueError(f"{rel(path)}:{index + 1}: row must be a mapping")
            rows.append(data)
    return rows


def payload_revision(payload_dir: Path) -> str:
    revision_path = payload_dir / ".hf_revision"
    if revision_path.is_file():
        return revision_path.read_text(encoding="utf-8").strip()
    return "missing_hf_revision"


def sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")


def split_for(asset_id: str, file_name: str, row_index: int) -> str:
    digest = hashlib.sha256(f"{asset_id}:{file_name}:{row_index}".encode()).hexdigest()
    bucket = int(digest[:8], 16) % 10
    if bucket == 8:
        return "val"
    if bucket == 9:
        return "test"
    return "train"


def make_record(
    asset: dict[str, Any],
    payload_dir: Path,
    path: Path,
    row: dict[str, Any],
    row_index: int,
    source_sha: str,
) -> dict[str, Any]:
    asset_id = str(asset["id"])
    instruction = row.get("instruction")
    output = row.get("output")
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError(f"{rel(path)}:{row_index + 1}: missing instruction")
    if not isinstance(output, str) or not output.strip():
        raise ValueError(f"{rel(path)}:{row_index + 1}: missing output")
    record_id = f"{sanitize(asset_id)}.{sanitize(path.stem)}.{row_index:06d}"
    source_id = row.get("id")
    content = {
        "output": output,
        "source_asset": asset_id,
        "source_file": rel(path),
        "source_url": asset["source_url"],
        "source_row_index": row_index,
        "source_id": source_id if isinstance(source_id, str) else None,
        "hf_revision": payload_revision(payload_dir),
        "policy": {
            "generated_rtl_quarantined_until_review": True,
            "requires_license_schema_and_contamination_review": True,
            "deterministic_simulation_or_formal_replay_required": True,
            "no_release_or_e1_optimization_claim_from_text_record": True,
        },
    }
    if isinstance(row.get("tb"), str):
        content["testbench"] = row["tb"]
    if isinstance(row.get("tb_result"), str):
        content["testbench_result"] = row["tb_result"]
    return {
        "schema": "eda.text_instruction_sample.v1",
        "id": record_id,
        "asset_id": asset_id,
        "source": {
            "path": rel(path),
            "sha256": source_sha,
            "row_index": row_index,
        },
        "split": split_for(asset_id, path.name, row_index),
        "task_type": "verireason_rtl_generation_with_testbench_feedback",
        "prompt": instruction,
        "response": {
            "kind": "structured_verireason_rtl_coder_sample",
            "content": content,
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py",
            "source_revision": f"{asset_id}:{payload_revision(payload_dir)}",
        },
        "replay": {
            "deterministic_command": (
                "python3 scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py "
                "--run-id <run-id>"
            ),
            "expected_report": "build/ai_eda/verireason_rtl_coder/<run-id>/conversion_report.json",
        },
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_root = args.out_root / args.run_id
    records_dir = out_root / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    for stale in records_dir.glob("*.json"):
        stale.unlink()

    converted: list[dict[str, Any]] = []
    asset_reports: list[dict[str, Any]] = []
    split_counts: Counter[str] = Counter()
    tb_count = 0
    tb_result_count = 0
    blocked_assets: list[str] = []

    for asset in ASSETS:
        payload_dir = ROOT / str(asset["payload"])
        file_reports: list[dict[str, Any]] = []
        asset_record_count = 0
        if not payload_dir.is_dir():
            blocked_assets.append(str(asset["id"]))
            continue
        revision = payload_revision(payload_dir)
        for file_name in asset["files"]:
            path = payload_dir / str(file_name)
            if not path.is_file():
                blocked_assets.append(f"{asset['id']}:{file_name}")
                continue
            source_sha = sha256_file(path)
            rows = load_jsonl(path)
            file_record_ids: list[str] = []
            for row_index, row in enumerate(rows):
                record = make_record(asset, payload_dir, path, row, row_index, source_sha)
                out_path = records_dir / f"{record['id']}.json"
                out_path.write_text(
                    json.dumps(record, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                split_counts[str(record["split"])] += 1
                content = record["response"]["content"]
                if "testbench" in content:
                    tb_count += 1
                if "testbench_result" in content:
                    tb_result_count += 1
                asset_record_count += 1
                file_record_ids.append(str(record["id"]))
                converted.append(
                    {
                        "id": record["id"],
                        "asset_id": record["asset_id"],
                        "schema": record["schema"],
                        "json": rel(out_path),
                        "source_file": rel(path),
                        "source_sha256": source_sha,
                        "source_row_index": row_index,
                        "split": record["split"],
                        "task_type": record["task_type"],
                    }
                )
            file_reports.append(
                {
                    "path": rel(path),
                    "sha256": source_sha,
                    "line_count": len(rows),
                    "record_count": len(file_record_ids),
                    "record_ids": file_record_ids,
                }
            )
        asset_reports.append(
            {
                "id": asset["id"],
                "source_url": asset["source_url"],
                "payload_path": rel(payload_dir),
                "hf_revision": revision,
                "record_count": asset_record_count,
                "files": file_reports,
            }
        )

    report = {
        "schema": "eliza.ai_eda.verireason_rtl_coder_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "converted_asset_count": len([item for item in asset_reports if item["record_count"] > 0]),
        "converted_record_count": len(converted),
        "blocked_assets": blocked_assets,
        "split_counts": dict(sorted(split_counts.items())),
        "testbench_record_count": tb_count,
        "testbench_result_record_count": tb_result_count,
        "assets": asset_reports,
        "converted_records": converted,
        "policy": {
            "metadata_and_text_normalization_only": True,
            "contains_model_weights": False,
            "runs_training": False,
            "runs_inference": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            **FALSE_CLAIM_FLAGS,
            "generated_rtl_quarantined_until_review": True,
            "deterministic_replay_required_for_optimization_claims": True,
        },
    }
    report_path = out_root / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if blocked_assets:
        print(
            "STATUS: FAIL ai_eda.verireason_rtl_coder "
            f"blocked_assets={','.join(blocked_assets)} report={rel(report_path)}"
        )
        return 1
    print(
        "STATUS: PASS ai_eda.verireason_rtl_coder "
        f"assets={report['converted_asset_count']} records={len(converted)} "
        f"report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
