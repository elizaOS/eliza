#!/usr/bin/env python3
"""
Inventory, sample, and normalize external scam datasets from Hugging Face.

This script is designed for two immediate needs:
1. Review external scam corpora before mixing them into Babylon training.
2. Produce a canonical preview corpus with exact-text dedup signals so we can
   decide which datasets are useful for SFT, detector pretraining, or
   ScamBench augmentation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from huggingface_hub import HfApi, hf_hub_download

os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


DEFAULT_DATASET_IDS = [
    "BluefinTuna/scam-finetune-v1",
    "radius27/scam_finetuned",
    "BothBosu/scam-dialogue",
    "BothBosu/Scammer-Conversation",
    "donksg/scam_finetune",
    "rzeydelis/autotrain-data-discord-scams-detector",
    "FredZhang7/all-scam-spam",
    "alissonpadua/ham-spam-scam-toxic",
    "BothBosu/youtube-scam-conversations",
    "BothBosu/multi-agent-scam-conversation",
    "BothBosu/single-agent-scam-conversations",
    "mytestaccforllm/final_scam",
    "Rainnighttram/Scam_Detect_20",
    "Rainnighttram/Scam_Detect_Split",
    "Rainnighttram/Scam_detect_50",
    "haoyaqi/scam_dataset",
    "SparkyPilot/scam-detection-data",
    "menaattia/phone-scam-dataset",
    "yichenw3/real-life-scam-reachout",
    "fadhilr/scam_call_gemma3",
    "thananos/augmented-train-scam-dialogue",
    "thananos/augmented-scam-dialogue",
    "AmSpotNot1221/scam-call",
    "wangyuancheng/discord-phishing-scam",
    "wangyuancheng/discord-phishing-scam-clean",
    "shakeleoatmeal/phone-scam-detection-synthetic",
    "kevinchiu37/scam-detection-logs",
    "Vuong23/scam_response_for_llama",
    "kevinchiu37/scam-detection-feedback",
    "Lyr1k/multi-agent-scam-conversation",
    "difraud/difraud",
]

DATA_EXTENSIONS = (".parquet", ".csv", ".jsonl", ".json")
CONVERSATION_HINTS = (
    "conversation",
    "dialogue",
    "dialog",
    "transcript",
    "history",
    "messages",
    "chat",
    "thread",
)
TEXT_HINTS = (
    "text",
    "message",
    "content",
    "utterance",
    "prompt",
    "input",
    "body",
    "query",
    "reachout",
)
LABEL_HINTS = (
    "label",
    "class",
    "target",
    "scam",
    "spam",
    "ham",
    "fraud",
    "phishing",
    "is_scam",
    "category",
)
RESPONSE_HINTS = (
    "response",
    "reply",
    "assistant",
    "output",
    "answer",
)


@dataclass
class CanonicalRecord:
    source_dataset: str
    source_file: str
    row_index: int
    inferred_shape: str
    canonical_text: str
    canonical_hash: str
    label: str | None
    transform_bucket: str
    prompt_text: str | None = None
    response_text: str | None = None
    raw_preview: str | None = None


@dataclass
class DatasetReview:
    dataset_id: str
    status: str
    downloads: int | None = None
    likes: int | None = None
    tags: list[str] | None = None
    data_files: list[str] | None = None
    sampled_file: str | None = None
    materialization_files: list[str] | None = None
    sample_columns: list[str] | None = None
    inferred_shape: str | None = None
    transform_bucket: str | None = None
    transform_notes: list[str] | None = None
    sampled_rows: int = 0
    unique_rows: int = 0
    duplicate_rows: int = 0
    sample_row_previews: list[dict[str, Any]] | None = None
    error: str | None = None


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_for_hash(text: str) -> str:
    lowered = normalize_whitespace(text).lower()
    return re.sub(r"[^\w\s]+", "", lowered)


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def json_preview(value: Any, max_length: int = 320) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False, default=str)
    except TypeError:
        rendered = repr(value)
    rendered = normalize_whitespace(rendered)
    if len(rendered) <= max_length:
        return rendered
    return rendered[: max_length - 1].rstrip() + "…"


def make_json_safe(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, dict):
        return {str(key): make_json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [make_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [make_json_safe(item) for item in value]
    return value


def list_data_files(siblings: Iterable[Any]) -> list[str]:
    files = [
        sibling.rfilename for sibling in siblings if sibling.rfilename.endswith(DATA_EXTENSIONS)
    ]

    def sort_key(name: str) -> tuple[int, int, str]:
        lowered = name.lower()
        priority = 9
        if "train" in lowered:
            priority = 0
        elif "all" in lowered:
            priority = 1
        elif "clean" in lowered:
            priority = 2
        elif "test" in lowered:
            priority = 5
        ext_priority = {".parquet": 0, ".csv": 1, ".jsonl": 2, ".json": 3}
        ext = Path(name).suffix.lower()
        return (priority, ext_priority.get(ext, 9), lowered)

    return sorted(files, key=sort_key)


def choose_sample_file(data_files: list[str]) -> str | None:
    if not data_files:
        return None
    return data_files[0]


def choose_materialization_files(data_files: list[str]) -> list[str]:
    if not data_files:
        return []

    preferred_split_hints = ("train", "validation", "val", "dev", "clean", "all")
    preferred = [
        name for name in data_files if any(hint in name.lower() for hint in preferred_split_hints)
    ]
    if preferred:
        return preferred
    return list(data_files)


def load_sample_rows(dataset_id: str, filename: str, sample_rows: int) -> list[dict[str, Any]]:
    path = hf_hub_download(
        repo_id=dataset_id,
        repo_type="dataset",
        filename=filename,
        etag_timeout=30,
    )
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        try:
            frame = pd.read_csv(path, nrows=sample_rows, encoding="utf-8")
        except UnicodeDecodeError:
            frame = pd.read_csv(path, nrows=sample_rows, encoding="latin-1")
    elif suffix == ".parquet":
        frame = pd.read_parquet(path).head(sample_rows)
    elif suffix == ".jsonl":
        frame = pd.read_json(path, lines=True).head(sample_rows)
    elif suffix == ".json":
        try:
            parsed = json.loads(Path(path).read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            parsed = json.loads(Path(path).read_text(encoding="latin-1"))
        if isinstance(parsed, list):
            frame = pd.DataFrame(parsed[:sample_rows])
        elif isinstance(parsed, dict):
            # Common case: {"train":[...]} or {"data":[...]}
            nested_rows = None
            for value in parsed.values():
                if isinstance(value, list):
                    nested_rows = value[:sample_rows]
                    break
            if nested_rows is None:
                frame = pd.DataFrame([parsed])
            else:
                frame = pd.DataFrame(nested_rows)
        else:
            frame = pd.DataFrame([{"value": parsed}])
    else:
        raise ValueError(f"Unsupported data file type: {filename}")

    frame = frame.where(pd.notnull(frame), None)
    return frame.to_dict(orient="records")


def looks_like_list_of_messages(value: Any) -> bool:
    return isinstance(value, list) and any(isinstance(item, dict) for item in value)


def pick_first(row: dict[str, Any], candidates: Iterable[str]) -> Any:
    lowered = {key.lower(): key for key in row}
    for candidate in candidates:
        if candidate in row:
            return row[candidate]
        actual = lowered.get(candidate.lower())
        if actual is not None:
            return row[actual]
    return None


def keys_matching(row: dict[str, Any], hints: Iterable[str]) -> list[str]:
    matched: list[str] = []
    for key in row:
        lowered = str(key).lower()
        if any(hint in lowered for hint in hints):
            matched.append(key)
    return matched


def infer_shape(sample_rows: list[dict[str, Any]]) -> str:
    if not sample_rows:
        return "empty"

    row = sample_rows[0]
    conversation_keys = keys_matching(row, CONVERSATION_HINTS)
    response_keys = keys_matching(row, RESPONSE_HINTS)
    label_keys = keys_matching(row, LABEL_HINTS)
    text_keys = keys_matching(row, TEXT_HINTS)

    if any(looks_like_list_of_messages(row.get(key)) for key in conversation_keys):
        return "messages"
    if conversation_keys:
        return "conversation_text"
    if response_keys and text_keys:
        return "prompt_response"
    if text_keys and label_keys:
        return "text_classification"
    if text_keys:
        return "freeform_text"
    return "unknown"


def infer_label(row: dict[str, Any]) -> str | None:
    label_keys = keys_matching(row, LABEL_HINTS)
    for key in label_keys:
        value = row.get(key)
        if value is None or (isinstance(value, float) and math.isnan(value)):
            continue
        return normalize_whitespace(str(value))
    return None


def canonicalize_row(
    dataset_id: str,
    filename: str,
    row_index: int,
    row: dict[str, Any],
    inferred_shape: str,
) -> CanonicalRecord | None:
    label = infer_label(row)
    prompt_text: str | None = None
    response_text: str | None = None
    canonical_text: str | None = None
    transform_bucket = "review_only"

    if inferred_shape == "messages":
        key = keys_matching(row, CONVERSATION_HINTS)[0]
        value = row.get(key)
        canonical_text = json_preview(value, max_length=4000)
        transform_bucket = "conversation_augmentation"
    elif inferred_shape == "conversation_text":
        key = keys_matching(row, CONVERSATION_HINTS)[0]
        value = row.get(key)
        canonical_text = normalize_whitespace(str(value or ""))
        transform_bucket = "conversation_augmentation"
    elif inferred_shape == "prompt_response":
        prompt_key = keys_matching(row, TEXT_HINTS)[0]
        response_key = keys_matching(row, RESPONSE_HINTS)[0]
        prompt_text = normalize_whitespace(str(row.get(prompt_key) or ""))
        response_text = normalize_whitespace(str(row.get(response_key) or ""))
        canonical_text = f"PROMPT: {prompt_text}\nRESPONSE: {response_text}".strip()
        transform_bucket = "sft_augmentation"
    elif inferred_shape in {"text_classification", "freeform_text"}:
        text_key = keys_matching(row, TEXT_HINTS)[0]
        prompt_text = normalize_whitespace(str(row.get(text_key) or ""))
        canonical_text = prompt_text
        transform_bucket = (
            "detector_pretraining" if inferred_shape == "text_classification" else "review_only"
        )

    if not canonical_text:
        fallback = json_preview(row, max_length=4000)
        if not fallback:
            return None
        canonical_text = fallback

    normalized = normalize_for_hash(canonical_text)
    if not normalized:
        return None

    return CanonicalRecord(
        source_dataset=dataset_id,
        source_file=filename,
        row_index=row_index,
        inferred_shape=inferred_shape,
        canonical_text=canonical_text,
        canonical_hash=stable_hash(normalized),
        label=label,
        transform_bucket=transform_bucket,
        prompt_text=prompt_text,
        response_text=response_text,
        raw_preview=json_preview(row),
    )


def transform_notes_for_shape(inferred_shape: str) -> list[str]:
    if inferred_shape == "messages":
        return [
            "Conversation-shaped data. Best candidate for ScamBench augmentation and transcript SFT.",
            "Need speaker-role mapping so attacker and target turns are aligned with Babylon/ScamBench transcripts.",
        ]
    if inferred_shape == "conversation_text":
        return [
            "Conversation stored as a single text field. Can be split into turns heuristically.",
            "Good candidate for harder long-con ScamBench scripts after role extraction and cleanup.",
        ]
    if inferred_shape == "prompt_response":
        return [
            "Prompt/response pairs. Good SFT material for anti-scam policy shaping.",
            "Not ideal for direct ScamBench augmentation unless we synthesize missing prior transcript turns.",
        ]
    if inferred_shape == "text_classification":
        return [
            "Detector-style dataset. Useful for classifier heads, reward models, and hard-negative mining.",
            "Not direct target-agent SFT unless converted into agent-facing transcripts or decision tasks.",
        ]
    if inferred_shape == "freeform_text":
        return [
            "Freeform text without clear labels. Review manually before using in training.",
        ]
    return [
        "Schema could not be inferred confidently. Manual review required before use.",
    ]


def render_markdown_summary(
    reviews: list[DatasetReview],
    duplicate_groups: dict[str, list[dict[str, Any]]],
    output_dir: Path,
) -> str:
    lines = [
        "# External Scam Dataset Review",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Summary",
        "",
        f"- Datasets requested: {len(reviews)}",
        f"- Inventory succeeded: {sum(1 for review in reviews if review.status == 'ok')}",
        f"- Inventory failed: {sum(1 for review in reviews if review.status != 'ok')}",
        f"- Duplicate preview groups: {len(duplicate_groups)}",
        "",
        "## Dataset Review",
        "",
    ]

    for review in reviews:
        lines.append(f"### {review.dataset_id}")
        lines.append("")
        lines.append(f"- Status: `{review.status}`")
        if review.error:
            lines.append(f"- Error: `{review.error}`")
        if review.downloads is not None:
            lines.append(f"- Downloads: `{review.downloads}`")
        if review.likes is not None:
            lines.append(f"- Likes: `{review.likes}`")
        if review.inferred_shape:
            lines.append(f"- Inferred Shape: `{review.inferred_shape}`")
        if review.transform_bucket:
            lines.append(f"- Transform Bucket: `{review.transform_bucket}`")
        if review.sample_columns:
            lines.append(
                f"- Sample Columns: `{', '.join(str(column) for column in review.sample_columns[:12])}`"
            )
        if review.materialization_files:
            preview = ", ".join(review.materialization_files[:6])
            if len(review.materialization_files) > 6:
                preview += ", …"
            lines.append(
                f"- Materialization Files: `{preview}` ({len(review.materialization_files)} files)"
            )
        if review.transform_notes:
            for note in review.transform_notes:
                lines.append(f"- Note: {note}")
        if review.sample_row_previews:
            for preview in review.sample_row_previews[:2]:
                lines.append(f"- Sample: `{json_preview(preview, max_length=220)}`")
        lines.append("")

    if duplicate_groups:
        lines.extend(["## Duplicate Preview Groups", ""])
        for canonical_hash, members in list(duplicate_groups.items())[:50]:
            lines.append(f"### `{canonical_hash[:12]}`")
            lines.append("")
            for member in members:
                lines.append(
                    f"- `{member['source_dataset']}` / `{member['source_file']}` / row `{member['row_index']}`"
                )
            lines.append("")

    lines.extend(
        [
            "## Artifacts",
            "",
            f"- Inventory JSON: `{output_dir / 'inventory.json'}`",
            f"- Canonical Preview JSONL: `{output_dir / 'canonical_preview.jsonl'}`",
            f"- Duplicate Groups JSON: `{output_dir / 'duplicate_groups.json'}`",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Review and normalize external scam datasets from Hugging Face."
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for inventory artifacts. Defaults to babylon/training-data/external-scam-datasets/<timestamp>.",
    )
    parser.add_argument(
        "--sample-rows",
        type=int,
        default=50,
        help="Rows to load from the sampled data file for each dataset.",
    )
    parser.add_argument(
        "--dataset-id",
        action="append",
        default=None,
        help="Optional dataset id override. Repeat to review a subset.",
    )
    args = parser.parse_args()

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else (
            Path(__file__).resolve().parents[4]
            / "training-data"
            / "external-scam-datasets"
            / timestamp
        )
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    dataset_ids = args.dataset_id or DEFAULT_DATASET_IDS
    api = HfApi()
    reviews: list[DatasetReview] = []
    canonical_records: list[CanonicalRecord] = []
    duplicate_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for dataset_id in dataset_ids:
        review = DatasetReview(dataset_id=dataset_id, status="ok")
        try:
            info = api.dataset_info(dataset_id)
            review.downloads = getattr(info, "downloads", None)
            review.likes = getattr(info, "likes", None)
            review.tags = list(getattr(info, "tags", None) or [])
            review.data_files = list_data_files(getattr(info, "siblings", None) or [])
            review.materialization_files = choose_materialization_files(review.data_files)

            sample_file = choose_sample_file(review.materialization_files or review.data_files)
            review.sampled_file = sample_file
            if not sample_file:
                review.status = "no_data_files"
                review.error = "No CSV/JSON/Parquet files found in dataset repo."
                reviews.append(review)
                continue

            sample_rows = load_sample_rows(dataset_id, sample_file, args.sample_rows)
            review.sample_columns = list(sample_rows[0].keys()) if sample_rows else []
            review.sample_row_previews = [make_json_safe(row) for row in sample_rows[:2]]
            review.sampled_rows = len(sample_rows)
            review.inferred_shape = infer_shape(sample_rows)
            first_record = None
            review.transform_bucket = None
            for row_index, row in enumerate(sample_rows):
                canonical = canonicalize_row(
                    dataset_id=dataset_id,
                    filename=sample_file,
                    row_index=row_index,
                    row=row,
                    inferred_shape=review.inferred_shape,
                )
                if canonical is None:
                    continue
                first_record = first_record or canonical
                canonical_records.append(canonical)
                duplicate_groups[canonical.canonical_hash].append(
                    {
                        "source_dataset": canonical.source_dataset,
                        "source_file": canonical.source_file,
                        "row_index": canonical.row_index,
                    }
                )
            if first_record is not None:
                review.transform_bucket = first_record.transform_bucket
            review.transform_notes = transform_notes_for_shape(review.inferred_shape)
        except Exception as exc:
            review.status = "error"
            review.error = f"{type(exc).__name__}: {exc}"
        reviews.append(review)

    duplicate_groups = {
        canonical_hash: members
        for canonical_hash, members in duplicate_groups.items()
        if len(members) > 1
    }
    duplicate_hashes = set(duplicate_groups)
    counts_by_dataset = Counter(record.source_dataset for record in canonical_records)
    duplicate_counts_by_dataset = Counter(
        record.source_dataset
        for record in canonical_records
        if record.canonical_hash in duplicate_hashes
    )

    for review in reviews:
        review.unique_rows = counts_by_dataset.get(review.dataset_id, 0)
        review.duplicate_rows = duplicate_counts_by_dataset.get(review.dataset_id, 0)

    inventory_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_count": len(reviews),
        "canonical_preview_count": len(canonical_records),
        "duplicate_group_count": len(duplicate_groups),
        "reviews": [asdict(review) for review in reviews],
    }
    (output_dir / "inventory.json").write_text(
        json.dumps(inventory_payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    with (output_dir / "canonical_preview.jsonl").open("w", encoding="utf-8") as handle:
        for record in canonical_records:
            handle.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")
    (output_dir / "duplicate_groups.json").write_text(
        json.dumps(duplicate_groups, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (output_dir / "inventory.md").write_text(
        render_markdown_summary(reviews, duplicate_groups, output_dir),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "datasets_reviewed": len(reviews),
                "inventory_succeeded": sum(1 for review in reviews if review.status == "ok"),
                "inventory_failed": sum(1 for review in reviews if review.status != "ok"),
                "canonical_preview_count": len(canonical_records),
                "duplicate_group_count": len(duplicate_groups),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
