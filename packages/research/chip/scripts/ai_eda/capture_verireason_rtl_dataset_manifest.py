#!/usr/bin/env python3
"""Capture local VeriReason RTL-Coder dataset integrity evidence.

This is a training-corpus intake gate only. It records pinned Hugging Face
payload revisions, JSONL row counts, content hashes, and quarantine policy.
It does not train, execute generated RTL, or claim E1 optimization/signoff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/verireason_rtl_datasets"
SCHEMA = "eliza.ai_eda.verireason_rtl_dataset_manifest.v1"
CLAIM_BOUNDARY = (
    "verireason_rtl_dataset_manifest_training_only_no_rtl_execution_or_e1_signoff_claim"
)
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "rtl_execution_claim_allowed": False,
    "e1_signoff_evidence": False,
    "optimization_claim_allowed": False,
}

DATASETS: tuple[dict[str, Any], ...] = (
    {
        "asset_id": "verireason-rtl-coder-small",
        "dataset_id": "Nellyw888/RTL-Coder_small",
        "payload": "external/datasets/verireason-rtl-coder-small/payload",
        "revision": "801eea76297a75ad4e1facdfccdc68aff6c89121",
        "jsonl_files": (
            {
                "filename": "randomized_filtered_data_7b.jsonl",
                "rows": 1310,
                "size_bytes": 1489849,
                "sha256": "a803a7fa1fbeb08441aa630384c286e96cd46fa855bdb907479105af6eea537b",
                "required_fields": ("instruction", "output"),
            },
            {
                "filename": "randomized_filtered_data_fixed.jsonl",
                "rows": 1339,
                "size_bytes": 1171807,
                "sha256": "e7eb0ed92e78240a68260b0984154810465e300ec75ce79dca9d7cbe0e528943",
                "required_fields": ("instruction", "output"),
            },
        ),
    },
    {
        "asset_id": "verireason-rtl-coder-reasoning-simple",
        "dataset_id": "Nellyw888/RTL-Coder_7b_reasoning_tb_simple",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-simple/payload",
        "revision": "61cc6a2a326dc96cb93bceb0e2040b953f0cb0a5",
        "jsonl_files": (
            {
                "filename": "processed_entries.jsonl",
                "rows": 743,
                "size_bytes": 7673835,
                "sha256": "8ec54cb605e48bc29acf72a77d4a8850d990df70aa0c8e25b778d30a7776241a",
                "required_fields": ("id", "instruction", "output", "tb", "tb_result"),
            },
        ),
    },
    {
        "asset_id": "verireason-rtl-coder-reasoning-hard",
        "dataset_id": "Nellyw888/RTL-Coder_7b_reasoning_tb",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-hard/payload",
        "revision": "42823db968114c25da260dece0e4bea8ab20d573",
        "jsonl_files": (
            {
                "filename": "train_tb_filtered.jsonl",
                "rows": 1149,
                "size_bytes": 11833942,
                "sha256": "ca03fa1b7be46a7ba56db17587cd3c20a18073303ba986096164422bb7746417",
                "required_fields": ("id", "instruction", "output", "tb", "tb_result"),
            },
        ),
    },
    {
        "asset_id": "verireason-rtl-coder-reasoning-combined",
        "dataset_id": "Nellyw888/RTL-Coder_7b_reasoning_tb_combined",
        "payload": "external/datasets/verireason-rtl-coder-reasoning-combined/payload",
        "revision": "28f8f2a9f78febe50fe581904a31c7aff718dc6a",
        "jsonl_files": (
            {
                "filename": "combined_dataset.jsonl",
                "rows": 1892,
                "size_bytes": 19507777,
                "sha256": "7eae7f528b743e907c99ed228fc6838559c4ebb8177541b7995fe878658c1444",
                "required_fields": ("id", "instruction", "output", "tb", "tb_result"),
            },
        ),
    },
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_jsonl_rows(path: Path) -> int | None:
    if not path.is_file():
        return None
    with path.open("rb") as handle:
        return sum(1 for _ in handle)


def first_row_keys(path: Path) -> list[str]:
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                if not isinstance(row, dict):
                    return []
                return sorted(row)
    return []


def capture_file(payload: Path, spec: dict[str, Any]) -> dict[str, Any]:
    path = payload / spec["filename"]
    keys = first_row_keys(path)
    required_fields = list(spec["required_fields"])
    present = path.is_file()
    rows = count_jsonl_rows(path)
    size = path.stat().st_size if present else None
    digest = sha256_file(path)
    errors: list[str] = []
    if not present:
        errors.append("missing")
    if rows != spec["rows"]:
        errors.append("row_count_mismatch")
    if size != spec["size_bytes"]:
        errors.append("size_mismatch")
    if digest != spec["sha256"]:
        errors.append("sha256_mismatch")
    missing_fields = sorted(set(required_fields) - set(keys))
    if missing_fields:
        errors.append("missing_required_fields")
    return {
        "filename": spec["filename"],
        "path": rel(path),
        "present": present,
        "status": "VERIFIED" if not errors else "BLOCKED",
        "expected_rows": spec["rows"],
        "actual_rows": rows,
        "expected_size_bytes": spec["size_bytes"],
        "actual_size_bytes": size,
        "expected_sha256": spec["sha256"],
        "actual_sha256": digest,
        "required_fields": required_fields,
        "first_row_keys": keys,
        "missing_required_fields": missing_fields,
        "errors": errors,
    }


def capture_dataset(spec: dict[str, Any]) -> dict[str, Any]:
    payload = repo_path(spec["payload"])
    revision_path = payload / ".hf_revision"
    actual_revision = (
        revision_path.read_text(encoding="utf-8").strip() if revision_path.is_file() else None
    )
    files = [capture_file(payload, file_spec) for file_spec in spec["jsonl_files"]]
    readme = payload / "README.md"
    blockers = [
        f"{item['filename']}: {','.join(item['errors'])}" for item in files if item["errors"]
    ]
    if actual_revision != spec["revision"]:
        blockers.append("hf_revision_mismatch")
    if not readme.is_file():
        blockers.append("README.md missing")
    return {
        "asset_id": spec["asset_id"],
        "dataset_id": spec["dataset_id"],
        "source_url": f"https://huggingface.co/datasets/{spec['dataset_id']}",
        "payload_path": rel(payload),
        "expected_revision": spec["revision"],
        "actual_revision": actual_revision,
        "revision_status": "VERIFIED" if actual_revision == spec["revision"] else "BLOCKED",
        "license_status": "dataset_card_review_required",
        "allowed_use": "training-only",
        "release_use_allowed": False,
        "generated_rtl_quarantined": True,
        "testbench_feedback_quarantined": True,
        "jsonl_file_count": len(files),
        "jsonl_row_count": sum(int(item["actual_rows"] or 0) for item in files),
        "jsonl_total_bytes": sum(int(item["actual_size_bytes"] or 0) for item in files),
        "files": files,
        "readme": {
            "path": rel(readme),
            "present": readme.is_file(),
            "size_bytes": readme.stat().st_size if readme.is_file() else None,
            "sha256": sha256_file(readme),
        },
        "status": "VERIFIED_TRAINING_ONLY_JSONL_PAYLOAD"
        if not blockers
        else "BLOCKED_INCOMPLETE_JSONL_PAYLOAD",
        "blockers": blockers,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    datasets = [capture_dataset(spec) for spec in DATASETS]
    blockers = [
        f"{dataset['asset_id']}: {blocker}"
        for dataset in datasets
        for blocker in dataset["blockers"]
    ]
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "VERIFIED_VERIREASON_RTL_DATASETS"
        if not blockers
        else "BLOCKED_VERIREASON_RTL_DATASETS",
        "release_use_allowed": False,
        "training_use_allowed": not blockers,
        "rtl_execution_claim_allowed": False,
        "e1_signoff_evidence": False,
        "optimization_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "summary": {
            "dataset_count": len(datasets),
            "jsonl_file_count": sum(dataset["jsonl_file_count"] for dataset in datasets),
            "jsonl_row_count": sum(dataset["jsonl_row_count"] for dataset in datasets),
            "jsonl_total_bytes": sum(dataset["jsonl_total_bytes"] for dataset in datasets),
            "blocker_count": len(blockers),
        },
        "contamination_review": {
            "status": "TRAINING_ONLY_QUARANTINE",
            "generated_rtl_execution_required_before_e1_use": True,
            "testbench_feedback_requires_lint_sim_formal_review": True,
            "e1_overlap_review": "no generated RTL or benchmark answer is release/signoff evidence",
        },
        "datasets": datasets,
        "blockers": blockers,
        "next_required_gates": [
            "complete dataset-card license review before release-derived use",
            "scan generated RTL for contamination/security before supervised fine-tuning",
            "lint, simulate, formally check, and synthesize any generated RTL before E1 replay",
            "keep public benchmark/testbench feedback separate from E1 signoff claims",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "dataset_manifest.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS" if not blockers else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.verireason_rtl_dataset_manifest "
        f"datasets={report['summary']['dataset_count']} rows={report['summary']['jsonl_row_count']} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
