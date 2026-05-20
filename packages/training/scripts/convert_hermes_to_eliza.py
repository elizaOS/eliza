"""Convert NousResearch Hermes function-calling datasets to eliza_native_v1 format.

Usage:
    python convert_hermes_to_eliza.py [--dataset DATASET] [--max-records N]
                                      [--hf-token TOKEN] [--dry-run]

Outputs JSONL to packages/training/data/converted/hermes/<dataset>.jsonl
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.native_record import (
    native_text_record,
    native_tool_call_record,
    stable_id,
    write_jsonl,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("convert_hermes")

ELIZA_SYSTEM_PROMPT = "You are Eliza, an AI assistant. Help the user with their request."

HERMES_DATASETS = {
    "hermes-function-calling-v1": "NousResearch/hermes-function-calling-v1",
    # Hermes-3 uses from/value conversation format; handled by _convert_record
    "hermes-3": "NousResearch/Hermes-3-Dataset",
    # Glaive function-calling v2: system+chat template format
    "glaive-function-calling-v2": "glaiveai/glaive-function-calling-v2",
}

_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_THINK_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL)

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
HERMES_SYSTEM_MARKER = "You are a function calling AI model"

ROLE_MAP = {
    "human": "user",
    "user": "user",
    "gpt": "assistant",
    "assistant": "assistant",
    "function": "tool",
    "tool": "tool",
    "system": "system",
}

MAX_TOKEN_ESTIMATE = 8192


def _estimate_tokens(text: str) -> int:
    return len(text) // 4


def _norm_role(role: str) -> str:
    return ROLE_MAP.get(role, ROLE_MAP.get(role.lower(), role.lower()))


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


def _extract_think(text: str) -> tuple[str, str]:
    m = _THINK_RE.match(text.strip())
    if m:
        thought = m.group(1).strip()
        rest = text[m.end():].strip()
        return thought, rest
    return "", text.strip()


_GLAIVE_CALL_RE = re.compile(r"<functioncall>\s*(\{.*?\})", re.DOTALL)


def _extract_tool_calls(text: str) -> list[dict[str, Any]]:
    calls = []
    # Hermes XML-style: <tool_call>...</tool_call>
    for m in _TOOL_CALL_RE.finditer(text):
        raw_json = m.group(1).strip()
        try:
            obj = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "name" in obj:
            calls.append({"name": obj["name"], "args": obj.get("arguments", obj.get("args", {}))})
    if calls:
        return calls
    # Glaive-style: <functioncall> {"name": ..., "arguments": ...}
    for m in _GLAIVE_CALL_RE.finditer(text):
        raw_json = m.group(1).strip()
        try:
            obj = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "name" in obj:
            args = obj.get("arguments", obj.get("args", {}))
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            calls.append({"name": obj["name"], "args": args if isinstance(args, dict) else {}})
    return calls


def _normalize_system(system: str) -> str:
    if HERMES_SYSTEM_MARKER in system:
        return ELIZA_SYSTEM_PROMPT
    return system.strip() or ELIZA_SYSTEM_PROMPT


_GLAIVE_FUNC_RE = re.compile(r"<functioncall>\s*(.*?)(?:\s*<\|endoftext\|>|\s*$)", re.DOTALL)
_GLAIVE_FUNC_RESP_RE = re.compile(r"FUNCTION RESPONSE:\s*(.*?)(?=USER:|A:|$)", re.DOTALL)


def _parse_glaive_chat(system_raw: str, chat: str) -> dict[str, Any] | None:
    """Parse glaive-function-calling-v2 system+chat fields into a raw conversations dict."""
    # Clean system prompt: strip "SYSTEM: " prefix and embedded function JSON
    system = re.sub(r"^SYSTEM:\s*", "", system_raw, flags=re.IGNORECASE).strip()
    # Remove the function listing embedded in system prompt
    system = re.sub(r"You are a helpful assistant with access to the following functions.*", "", system, flags=re.DOTALL).strip()
    system = system or ELIZA_SYSTEM_PROMPT

    # Split chat into turns
    parts = re.split(r"(USER:|A:)", chat)
    turns = []
    i = 1
    while i < len(parts) - 1:
        speaker = parts[i].strip()
        content = parts[i + 1].split("<|endoftext|>")[0].strip()
        i += 2
        if speaker == "USER:":
            # Strip out FUNCTION RESPONSE blocks (they're tool results embedded in user turn)
            func_resp = _GLAIVE_FUNC_RESP_RE.search(content)
            if func_resp:
                tool_result = func_resp.group(1).strip()
                content = content[:func_resp.start()].strip()
                if content:
                    turns.append({"from": "human", "value": content})
                if tool_result:
                    turns.append({"from": "tool", "value": tool_result})
            elif content:
                turns.append({"from": "human", "value": content})
        elif speaker == "A:":
            if content:
                turns.append({"from": "gpt", "value": content})

    return {"system_raw": system, "conversations": turns}


def _convert_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    # Handle glaive format (system + chat fields)
    if "chat" in raw and "system" in raw and "conversations" not in raw:
        parsed = _parse_glaive_chat(raw["system"], raw["chat"])
        if parsed is None:
            return None
        raw = {**raw, **parsed}

    conversations = raw.get("conversations") or raw.get("messages") or []
    if not conversations:
        return None

    system = raw.get("system_raw") or ELIZA_SYSTEM_PROMPT
    turns: list[dict[str, Any]] = []
    final_assistant: str | None = None
    final_tools_str: str | None = None

    for msg in conversations:
        role_raw = msg.get("role") or msg.get("from") or ""
        role = _norm_role(role_raw)
        content = msg.get("content") or msg.get("value") or ""
        if isinstance(content, list):
            content = " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
        content = str(content)

        if role == "system":
            system = _normalize_system(content)
            continue

        if role == "assistant":
            final_assistant = content
            final_tools_str = content
            continue

        if role in ("user", "tool"):
            turns.append({"role": role, "content": content})

    if final_assistant is None:
        return None

    if not any(t["role"] == "user" for t in turns):
        return None

    thought, response_text = _extract_think(final_assistant)
    tool_calls = _extract_tool_calls(final_tools_str or "")

    total_text = system + " ".join(t["content"] for t in turns) + (final_assistant or "")
    if _estimate_tokens(total_text) > MAX_TOKEN_ESTIMATE:
        return None

    if tool_calls:
        clean_response = _TOOL_CALL_RE.sub("", response_text).strip()
        return native_tool_call_record(
            system=system,
            turns=turns,
            thought=thought or "Use the appropriate tool to fulfill the request.",
            tool_calls=tool_calls,
            message_to_user=clean_response or None,
            metadata={"source": "hermes", "id": stable_id("hermes", raw.get("id", ""), final_assistant[:64])},
        )

    if _has_trope(response_text):
        return None

    if not response_text.strip():
        return None

    return native_text_record(
        system=system,
        user=turns,
        response_text=response_text,
        metadata={"source": "hermes", "id": stable_id("hermes", raw.get("id", ""), response_text[:64])},
    )


def convert_dataset(dataset_id: str, slug: str, max_records: int | None, hf_token: str | None) -> tuple[list[dict], dict[str, int]]:
    from datasets import load_dataset

    log.info("Loading %s ...", dataset_id)
    ds = load_dataset(dataset_id, token=hf_token, trust_remote_code=True)
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

    log.info("%s: total=%d converted=%d dropped=%d", slug, total, len(records), total - len(records))
    return records, drops


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert Hermes datasets to eliza_native_v1")
    parser.add_argument("--dataset", choices=list(HERMES_DATASETS.keys()), default=None,
                        help="Which Hermes dataset to convert (default: all)")
    parser.add_argument("--max-records", type=int, default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out_dir = ROOT / "data" / "converted" / "hermes"
    out_dir.mkdir(parents=True, exist_ok=True)

    datasets_to_run = {args.dataset: HERMES_DATASETS[args.dataset]} if args.dataset else HERMES_DATASETS

    all_total = 0
    all_converted = 0
    all_dropped = 0
    all_drop_reasons: dict[str, int] = {}

    for slug, dataset_id in datasets_to_run.items():
        try:
            records, drops = convert_dataset(dataset_id, slug, args.max_records, args.hf_token)
        except Exception as exc:
            log.warning("Skipping %s (%s): %s", slug, dataset_id, exc)
            continue
        n_dropped = sum(drops.values())
        all_total += len(records) + n_dropped
        all_converted += len(records)
        all_dropped += n_dropped
        for k, v in drops.items():
            all_drop_reasons[k] = all_drop_reasons.get(k, 0) + v

        if not args.dry_run and records:
            out_path = out_dir / f"{slug}.jsonl"
            n = write_jsonl(records, out_path)
            log.info("Wrote %d records to %s", n, out_path)
        elif args.dry_run:
            log.info("[dry-run] Would write %d records for %s", len(records), slug)

    print(f"\nSummary:")
    print(f"  Total records processed : {all_total}")
    print(f"  Converted               : {all_converted}")
    print(f"  Dropped                 : {all_dropped}")
    if all_drop_reasons:
        print("  Drop reasons:")
        for reason, count in sorted(all_drop_reasons.items(), key=lambda x: -x[1]):
            print(f"    {reason}: {count}")


if __name__ == "__main__":
    main()
