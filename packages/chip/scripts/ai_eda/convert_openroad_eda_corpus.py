#!/usr/bin/env python3
"""Convert the OpenROAD EDA Corpus into normalized text-instruction records."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = ROOT / "external/datasets/openroad-eda-corpus/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openroad_eda_corpus"
ASSET_ID = "openroad-eda-corpus"
CLAIM_BOUNDARY = "openroad_eda_corpus_conversion_only_no_training_inference_or_release_claim"

CSV_SOURCES = [
    ("Non-Augmented_Data/Question-Answer/Question-Answer_Dataset.csv", "question_answer"),
    ("Augmented_Data/Question-Answer/Flow/Flow.csv", "question_answer"),
    ("Augmented_Data/Question-Answer/General/General.csv", "question_answer"),
    ("Augmented_Data/Question-Answer/Tools/Tools.csv", "question_answer"),
    ("Non-Augmented_Data/Prompt-Script/DB_Dataset.csv", "prompt_script"),
    ("Non-Augmented_Data/Prompt-Script/Flow_Dataset.csv", "prompt_script"),
    ("Augmented_Data/Prompt-Script/DB/circuit_modification.csv", "prompt_script"),
    ("Augmented_Data/Prompt-Script/DB/query.csv", "prompt_script"),
    ("Augmented_Data/Prompt-Script/Flow/flow.csv", "prompt_script"),
]


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


def stable_split(record_id: str) -> str:
    value = int(hashlib.sha256(record_id.encode("utf-8")).hexdigest()[:8], 16) % 10
    if value == 0:
        return "test"
    if value == 1:
        return "val"
    return "train"


def git_revision(path: Path) -> str:
    head = path / ".git/HEAD"
    if not head.exists():
        return "UNKNOWN_NO_GIT_HEAD"
    text = head.read_text(encoding="utf-8").strip()
    if text.startswith("ref: "):
        ref = path / ".git" / text.removeprefix("ref: ")
        if ref.exists():
            return ref.read_text(encoding="utf-8").strip()
    return text


def read_csv_records(path: Path, task_type: str) -> list[dict[str, Any]]:
    file_hash = sha256_file(path)
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_index, row in enumerate(reader):
            if task_type == "question_answer":
                prompt = (row.get("Prompts") or row.get("prompt") or "").strip()
                response = (row.get("Answers") or row.get("answer") or "").strip()
                response_kind = "natural_language"
            else:
                prompt = (row.get("prompt") or row.get("Prompts") or "").strip()
                response = (row.get("code") or row.get("Code") or "").strip()
                response_kind = "python_or_tcl_script"
            if not prompt or not response:
                continue
            stem = rel(path).replace("/", ".").replace(".csv", "")
            record_id = f"{ASSET_ID}.{stem}.{row_index:06d}"
            records.append(
                {
                    "schema": "eda.text_instruction_sample.v1",
                    "id": record_id,
                    "asset_id": ASSET_ID,
                    "source": {
                        "path": rel(path),
                        "sha256": file_hash,
                        "row_index": row_index,
                    },
                    "split": stable_split(record_id),
                    "task_type": task_type,
                    "prompt": prompt,
                    "response": {
                        "kind": response_kind,
                        "content": response,
                    },
                    "provenance": {
                        "generated_by": "scripts/ai_eda/convert_openroad_eda_corpus.py",
                        "source_revision": git_revision(PAYLOAD),
                    },
                    "replay": {
                        "deterministic_command": "python3 scripts/ai_eda/convert_openroad_eda_corpus.py --run-id validation",
                        "expected_report": "build/ai_eda/openroad_eda_corpus/validation/conversion_report.json",
                    },
                    "claim_boundary": CLAIM_BOUNDARY,
                }
            )
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, default=PAYLOAD)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--sample-records", type=int, default=16)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    payload = args.payload
    if not payload.exists():
        errors.append(f"missing payload: {payload}")

    all_records: list[dict[str, Any]] = []
    per_source: list[dict[str, Any]] = []
    if not errors:
        for rel_path, task_type in CSV_SOURCES:
            source = payload / rel_path
            if not source.exists():
                errors.append(f"missing source CSV: {source}")
                continue
            records = read_csv_records(source, task_type)
            all_records.extend(records)
            per_source.append(
                {
                    "path": rel(source),
                    "task_type": task_type,
                    "record_count": len(records),
                    "sha256": sha256_file(source),
                }
            )

    out_dir = args.out_root / args.run_id
    records_dir = out_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True)
    split_counts = {"train": 0, "val": 0, "test": 0}
    records_by_split = {"train": [], "val": [], "test": []}
    for record in all_records:
        split = record["split"]
        split_counts[split] += 1
        records_by_split[split].append(record)

    for split, records in records_by_split.items():
        write_jsonl(out_dir / f"{split}.jsonl", records)
    for index, record in enumerate(all_records[: args.sample_records]):
        (records_dir / f"sample_{index:04d}.json").write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    report = {
        "schema": "eliza.ai_eda.openroad_eda_corpus_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "asset_id": ASSET_ID,
        "payload": rel(payload),
        "source_revision": git_revision(payload) if payload.exists() else None,
        "claim_boundary": CLAIM_BOUNDARY,
        "record_count": len(all_records),
        "split_counts": split_counts,
        "per_source": per_source,
        "outputs": {
            "train": rel(out_dir / "train.jsonl"),
            "val": rel(out_dir / "val.jsonl"),
            "test": rel(out_dir / "test.jsonl"),
            "sample_records": rel(records_dir),
        },
        "policy": {
            "training_ready_after_conversion": True,
            "release_use_allowed": False,
            "generated_tool_actions_allowed": False,
            "deterministic_replay_required_for_any_e1_change": True,
        },
        "errors": errors,
    }
    report_path = out_dir / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openroad_eda_corpus {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.openroad_eda_corpus "
        f"records={len(all_records)} train={split_counts['train']} "
        f"val={split_counts['val']} test={split_counts['test']} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
