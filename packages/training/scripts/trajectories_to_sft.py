#!/usr/bin/env python3
"""Build local SFT splits from Eliza-native runtime trajectory exports.

Accepted input is `eliza_native_v1` JSON/JSONL only. Each row is one Vercel AI
SDK model boundary: request prompt/messages/tools/toolChoice/providerOptions in,
response text/toolCalls/finishReason/usage out. The splitter preserves that row
shape so training, smoke evaluation, and later audits all consume the same
format.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("trajectories-to-sft")

Example = dict[str, Any]
INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}
NATIVE_FORMAT = "eliza_native_v1"
NATIVE_BOUNDARIES = {"vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"}


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _stable_unit(*parts: Any) -> float:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, sort_keys=True, default=str).encode("utf-8"))
        h.update(b"\0")
    return int(h.hexdigest()[:16], 16) / float(16**16)


def _iter_input_files(paths: Iterable[str]) -> Iterable[Path]:
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in INPUT_SUFFIXES:
                    yield child
        else:
            yield path


def _expand_top_level(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        yield from value
        return
    if isinstance(value, dict):
        for key in ("rows", "records", "examples", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from nested
                return
    yield value


def _read_json_records(path: Path) -> Iterable[Any]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return

    if text[0] in "[{":
        try:
            yield from _expand_top_level(json.loads(text))
            return
        except json.JSONDecodeError:
            pass

    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            yield from _expand_top_level(json.loads(line))
        except json.JSONDecodeError as exc:
            log.warning("skip invalid JSON %s:%d: %s", path, line_no, exc)


def _has_request_payload(request: dict[str, Any]) -> bool:
    messages = request.get("messages")
    if isinstance(messages, list) and len(messages) > 0:
        return True
    prompt = request.get("prompt")
    return isinstance(prompt, str) and len(prompt.strip()) > 0


def _has_response_payload(response: dict[str, Any]) -> bool:
    text = response.get("text")
    if isinstance(text, str) and len(text.strip()) > 0:
        return True
    tool_calls = response.get("toolCalls")
    return isinstance(tool_calls, list) and len(tool_calls) > 0


def infer_task_type(record: dict[str, Any]) -> str:
    metadata = _as_record(record.get("metadata")) or {}
    explicit = _clean(metadata.get("task_type") or metadata.get("taskType"))
    if explicit:
        return "response" if explicit == "reply" else explicit

    tokens: list[str] = []
    for key in ("purpose", "actionType", "stepType", "modelType"):
        value = _clean(record.get(key))
        if value:
            tokens.append(value.lower())
    tags = record.get("tags")
    if isinstance(tags, list):
        tokens.extend(_clean(tag).lower() for tag in tags if _clean(tag))

    token_text = " ".join(tokens).replace("-", "_")
    if "context_routing" in token_text:
        return "context_routing"
    if (
        "should_respond" in token_text
        or "response_handler" in token_text
        or "message_handler" in token_text
    ):
        return "should_respond"
    if any(part in token_text for part in ("action_planner", "planner", "runtime_use_model")):
        return "action_planner"
    if any(part in token_text for part in ("media_description", "describe_image", "describe_audio")):
        return "media_description"
    return "response"


def examples_from_record(record: Any) -> Iterable[Example]:
    rec = _as_record(record)
    if not rec or rec.get("format") != NATIVE_FORMAT:
        return
    if rec.get("boundary") not in NATIVE_BOUNDARIES:
        return

    request = _as_record(rec.get("request"))
    response = _as_record(rec.get("response"))
    if not request or not response:
        return
    if not _has_request_payload(request) or not _has_response_payload(response):
        return

    example = dict(rec)
    metadata = dict(_as_record(example.get("metadata")) or {})
    metadata.setdefault("task_type", infer_task_type(example))
    metadata.setdefault("source_dataset", "runtime_trajectory_boundary")
    example["metadata"] = metadata
    yield example


def _example_id(example: Example, index: int) -> str:
    metadata = _as_record(example.get("metadata")) or {}
    parts = [
        metadata.get("trajectory_id"),
        metadata.get("step_id"),
        metadata.get("call_id"),
        metadata.get("task_type"),
        example.get("trajectoryId"),
        example.get("stepId"),
        example.get("callId"),
    ]
    cleaned = [_clean(part) for part in parts if _clean(part)]
    return "|".join(cleaned) or str(index)


def _write_jsonl(path: Path, rows: list[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", action="append", required=True, help="eliza_native_v1 JSON/JSONL file or directory. Repeatable.")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--val-ratio", type=float, default=0.05)
    ap.add_argument("--test-ratio", type=float, default=0.05)
    ap.add_argument("--seed", default="eliza-native-trajectory-sft-v1")
    ap.add_argument("--max-records", type=int, default=0)
    ap.add_argument(
        "--tasks",
        default="",
        help="Optional comma-separated task_type allowlist.",
    )
    args = ap.parse_args()

    task_allowlist = {
        task.strip()
        for task in args.tasks.split(",")
        if task.strip()
    }
    output_dir = Path(args.output_dir)
    splits: dict[str, list[Example]] = {"train": [], "val": [], "test": []}
    counts = Counter()
    skipped = 0

    for path in _iter_input_files(args.input):
        if not path.exists():
            raise SystemExit(f"input path does not exist: {path}")
        log.info("reading %s", path)
        for raw in _read_json_records(path):
            produced = False
            for example in examples_from_record(raw):
                produced = True
                metadata = _as_record(example.get("metadata")) or {}
                task_type = _clean(metadata.get("task_type")) or "response"
                if task_allowlist and task_type not in task_allowlist:
                    continue
                idx = sum(len(rows) for rows in splits.values())
                if args.max_records and idx >= args.max_records:
                    break
                unit = _stable_unit(args.seed, _example_id(example, idx))
                if unit < args.test_ratio:
                    split = "test"
                elif unit < args.test_ratio + args.val_ratio:
                    split = "val"
                else:
                    split = "train"
                splits[split].append(example)
                counts[task_type] += 1
            if not produced:
                skipped += 1
            if args.max_records and sum(len(rows) for rows in splits.values()) >= args.max_records:
                break

    for split, rows in splits.items():
        _write_jsonl(output_dir / f"{split}.jsonl", rows)

    manifest = {
        "schema": "eliza.native_trajectory_sft_splits.v1",
        "format": NATIVE_FORMAT,
        "inputs": args.input,
        "output_dir": str(output_dir),
        "counts": {split: len(rows) for split, rows in splits.items()},
        "task_counts": dict(sorted(counts.items())),
        "skipped_records": skipped,
        "val_ratio": args.val_ratio,
        "test_ratio": args.test_ratio,
        "seed": args.seed,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("wrote %s", output_dir / "manifest.json")
    print(json.dumps(manifest, indent=2))
    return 0 if splits["train"] else 1


if __name__ == "__main__":
    sys.exit(main())
