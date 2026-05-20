"""Convert Salesforce/xlam-function-calling-60k to eliza_native_v1 format.

Usage:
    python convert_xlam_to_eliza.py [--max-records N] [--hf-token TOKEN] [--dry-run]

Outputs JSONL to packages/training/data/converted/xlam/xlam-function-calling-60k.jsonl

Dataset format (Salesforce/xlam-function-calling-60k):
  - tools: JSON string of list of tool definitions
  - query: user query string
  - answers: JSON string of list of tool calls [{name, arguments}]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.native_record import (
    native_tool_call_record,
    stable_id,
    write_jsonl,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("convert_xlam")

XLAM_DATASET = "Salesforce/xlam-function-calling-60k"
ELIZA_SYSTEM_PROMPT = "You are Eliza, an AI assistant. Help the user with their request."

MAX_TOKEN_ESTIMATE = 8192

TROPE_STARTS = (
    "Certainly!",
    "Of course!",
    "Sure!",
    "As an AI",
    "I'm an AI",
    "Great!",
    "Absolutely!",
)
TROPE_CONTAINS = (
    "You are an expert",
    "As an AI language model",
    "I'll help you with",
)


def _estimate_tokens(text: str) -> int:
    return len(text) // 4


def _has_trope(text: str) -> bool:
    if not text:
        return False
    stripped = text.strip()
    for prefix in TROPE_STARTS:
        if stripped.startswith(prefix):
            return True
    for phrase in TROPE_CONTAINS:
        if phrase in stripped:
            return True
    return False


def _parse_tools(tools_raw: Any) -> list[dict[str, Any]]:
    """Parse the tools field which is a JSON string of tool definitions."""
    if not tools_raw:
        return []
    if isinstance(tools_raw, list):
        return tools_raw
    if isinstance(tools_raw, str):
        try:
            parsed = json.loads(tools_raw)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return []


def _parse_answers(answers_raw: Any) -> list[dict[str, Any]]:
    """Parse the answers field which is a JSON string of tool calls.

    xlam format: [{"name": "fn", "arguments": {"k": "v"}}]
    """
    if not answers_raw:
        return []
    if isinstance(answers_raw, list):
        raw_calls = answers_raw
    elif isinstance(answers_raw, str):
        try:
            raw_calls = json.loads(answers_raw)
        except json.JSONDecodeError:
            return []
    else:
        return []

    calls = []
    for item in raw_calls:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("function", {}).get("name", "")
        args = item.get("arguments") or item.get("args") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if name and isinstance(args, dict):
            calls.append({"name": name, "args": args})
    return calls


def _convert_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    query = str(raw.get("query") or "").strip()
    if not query:
        return None

    tools = _parse_tools(raw.get("tools"))
    tool_calls = _parse_answers(raw.get("answers"))
    if not tool_calls:
        return None  # xlam is a tool-calling dataset; skip non-tool records

    total_text = ELIZA_SYSTEM_PROMPT + query + json.dumps(tool_calls)
    if _estimate_tokens(total_text) > MAX_TOKEN_ESTIMATE:
        return None

    rec_id = stable_id("xlam", str(raw.get("id", "")), query[:64])

    return native_tool_call_record(
        system=ELIZA_SYSTEM_PROMPT,
        turns=[{"role": "user", "content": query}],
        thought="Use the appropriate tool to fulfill the request.",
        tool_calls=tool_calls,
        message_to_user=None,
        tools=tools or None,
        metadata={"source": "xlam", "id": rec_id},
    )


def convert_dataset(max_records: int | None, hf_token: str | None) -> tuple[list[dict], dict[str, int]]:
    from datasets import load_dataset

    log.info("Loading %s ...", XLAM_DATASET)
    ds = load_dataset(XLAM_DATASET, token=hf_token, trust_remote_code=True)
    split = ds.get("train") or ds[list(ds.keys())[0]]

    records: list[dict] = []
    drops: dict[str, int] = {}
    total = 0

    for row in split:
        if max_records and total >= max_records:
            break
        total += 1
        try:
            rec = _convert_record(dict(row))
        except Exception as exc:
            drops[f"error: {type(exc).__name__}"] = drops.get(f"error: {type(exc).__name__}", 0) + 1
            continue
        if rec is None:
            drops["filtered"] = drops.get("filtered", 0) + 1
        else:
            records.append(rec)

    n_dropped = sum(drops.values())
    log.info("xlam-function-calling-60k: rows=%d output_records=%d dropped=%d",
             total, len(records), n_dropped)
    return records, drops


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert Salesforce xlam to eliza_native_v1")
    parser.add_argument("--max-records", type=int, default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out_dir = ROOT / "data" / "converted" / "xlam"
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        records, drops = convert_dataset(args.max_records, args.hf_token)
    except Exception as exc:
        log.error("Failed to convert xlam dataset: %s", exc)
        sys.exit(1)

    n_dropped = sum(drops.values())
    print(f"\nSummary:")
    print(f"  Converted : {len(records)}")
    print(f"  Dropped   : {n_dropped}")
    if drops:
        print("  Drop reasons:")
        for reason, count in sorted(drops.items(), key=lambda x: -x[1]):
            print(f"    {reason}: {count}")

    if not args.dry_run and records:
        out_path = out_dir / "xlam-function-calling-60k.jsonl"
        n = write_jsonl(records, out_path)
        log.info("Wrote %d records to %s", n, out_path)
    elif args.dry_run:
        log.info("[dry-run] Would write %d records", len(records))


if __name__ == "__main__":
    main()
