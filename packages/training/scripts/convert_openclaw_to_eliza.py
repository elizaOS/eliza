"""Convert CyberAGI/openclaw-operator-data to eliza_native_v1 format.

Usage:
    python convert_openclaw_to_eliza.py [--max-records N]
                                        [--hf-token TOKEN] [--dry-run]

Outputs JSONL to packages/training/data/converted/openclaw/openclaw-operator-data.jsonl
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
log = logging.getLogger("convert_openclaw")

OPENCLAW_DATASET = "awax1122/openclaw-opencode-dataset"
ELIZA_SYSTEM_PROMPT = "You are Eliza, an AI assistant. Help the user with their request."

_THINK_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL)
_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)

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
    "user": "user",
    "human": "user",
    "assistant": "assistant",
    "gpt": "assistant",
    "system": "system",
    "tool": "tool",
    "function": "tool",
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


def _normalize_system(system: str) -> str:
    if HERMES_SYSTEM_MARKER in system:
        return ELIZA_SYSTEM_PROMPT
    return system.strip() or ELIZA_SYSTEM_PROMPT


def _extract_think(text: str) -> tuple[str, str]:
    m = _THINK_RE.match(text.strip())
    if m:
        thought = m.group(1).strip()
        rest = text[m.end():].strip()
        return thought, rest
    return "", text.strip()


def _extract_tool_calls_from_content(content: str) -> list[dict[str, Any]]:
    calls = []
    for m in _TOOL_CALL_RE.finditer(content):
        raw = m.group(1).strip()
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "name" in obj:
            calls.append({"name": obj["name"], "args": obj.get("arguments", obj.get("args", {}))})
    return calls


def _extract_tool_calls_from_json(content: str) -> list[dict[str, Any]]:
    stripped = content.strip()
    if not stripped.startswith("{") and not stripped.startswith("["):
        return []
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        return []

    def normalize_call(tc: Any) -> dict[str, Any] | None:
        if not isinstance(tc, dict):
            return None
        fn = tc.get("function") or {}
        args = tc.get("arguments") or tc.get("args") or tc.get("input") or fn.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                pass
        name = tc.get("name") or tc.get("tool_name") or tc.get("toolName") or fn.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        return {"name": name.strip(), "args": args if isinstance(args, dict) else {}}

    if isinstance(obj, list):
        calls = [normalize_call(tc) for tc in obj]
        return [c for c in calls if c is not None]

    if isinstance(obj, dict):
        raw_calls = obj.get("tool_calls") or obj.get("toolCalls")
        if isinstance(raw_calls, list):
            calls = [normalize_call(tc) for tc in raw_calls]
            return [c for c in calls if c is not None]
        single = normalize_call(obj)
        if single:
            return [single]

    return []


def _content_str(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(p.get("text", ""))
            else:
                parts.append(str(p))
        return " ".join(parts)
    return str(content) if content is not None else ""


def _normalize_openclaw_tool_calls(raw_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for tc in raw_calls:
        name = tc.get("name", "").strip()
        args = tc.get("arguments") or tc.get("args") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        # Skip obvious placeholder calls
        if not name or (isinstance(args, dict) and args.get("command") == "echo placeholder"):
            continue
        result.append({"name": name, "args": args if isinstance(args, dict) else {}})
    return result


def _convert_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    messages = raw.get("messages") or raw.get("conversations") or []
    if not messages:
        return None

    system = ELIZA_SYSTEM_PROMPT
    turns: list[dict[str, Any]] = []
    final_assistant_content: str | None = None
    final_assistant_raw: dict[str, Any] | None = None

    for msg in messages:
        role_raw = msg.get("role") or msg.get("from") or ""
        role = _norm_role(role_raw)
        content = _content_str(msg.get("content") or msg.get("value") or "")

        if role == "system":
            system = _normalize_system(content)
            continue

        if role == "assistant":
            final_assistant_content = content
            final_assistant_raw = msg
            continue

        if role in ("user", "tool"):
            turns.append({"role": role, "content": content})

    # openclaw-opencode format: assistant response is in `target` dict, not messages
    target = raw.get("target")
    if final_assistant_content is None and isinstance(target, dict):
        thought_text = target.get("assistant", "").strip()
        final_response = target.get("final_response", "").strip()
        raw_tool_calls = target.get("tool_calls") or []

        if not any(t["role"] == "user" for t in turns):
            return None

        tool_calls = _normalize_openclaw_tool_calls(raw_tool_calls)

        record_id = stable_id("openclaw", raw.get("id", ""), final_response[:64])

        if tool_calls:
            return native_tool_call_record(
                system=system,
                turns=turns,
                thought=thought_text or "Use the appropriate tool to fulfill the request.",
                tool_calls=tool_calls,
                message_to_user=final_response or None,
                metadata={"source": "openclaw", "id": record_id, "task_type": raw.get("task_type")},
            )

        if not final_response or _has_trope(final_response):
            return None

        return native_text_record(
            system=system,
            user=turns,
            response_text=final_response,
            metadata={"source": "openclaw", "id": record_id, "task_type": raw.get("task_type")},
        )

    if final_assistant_content is None:
        return None

    if not any(t["role"] == "user" for t in turns):
        return None

    total_text = system + " ".join(t["content"] for t in turns) + final_assistant_content
    if _estimate_tokens(total_text) > MAX_TOKEN_ESTIMATE:
        return None

    thought, response_body = _extract_think(final_assistant_content)

    # Try XML-style tool calls first, then JSON-style
    tool_calls = _extract_tool_calls_from_content(response_body)
    if not tool_calls and final_assistant_raw:
        raw_tool_calls = final_assistant_raw.get("tool_calls")
        if isinstance(raw_tool_calls, (list, str)):
            if isinstance(raw_tool_calls, str):
                try:
                    raw_tool_calls = json.loads(raw_tool_calls)
                except json.JSONDecodeError:
                    raw_tool_calls = []
            for tc in raw_tool_calls:
                fn = tc.get("function") or {}
                args = fn.get("arguments") or tc.get("args") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        pass
                name = tc.get("name") or fn.get("name")
                if name:
                    tool_calls.append({"name": name, "args": args if isinstance(args, dict) else {}})
    if not tool_calls:
        tool_calls = _extract_tool_calls_from_json(response_body)

    record_id = stable_id("openclaw", raw.get("id", ""), final_assistant_content[:64])

    if tool_calls:
        clean_response = _TOOL_CALL_RE.sub("", response_body).strip()
        if not clean_response:
            try:
                json.loads(response_body.strip())
                clean_response = None
            except json.JSONDecodeError:
                pass
        return native_tool_call_record(
            system=system,
            turns=turns,
            thought=thought or "Use the appropriate tool to fulfill the request.",
            tool_calls=tool_calls,
            message_to_user=clean_response or None,
            metadata={"source": "openclaw", "id": record_id},
        )

    if _has_trope(response_body):
        return None

    if not response_body.strip():
        return None

    return native_text_record(
        system=system,
        user=turns,
        response_text=response_body,
        metadata={"source": "openclaw", "id": record_id},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert openclaw-operator-data to eliza_native_v1")
    parser.add_argument("--max-records", type=int, default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    from datasets import load_dataset

    out_dir = ROOT / "data" / "converted" / "openclaw"
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info("Loading %s ...", OPENCLAW_DATASET)
    ds = load_dataset(OPENCLAW_DATASET, token=args.hf_token, trust_remote_code=True)
    split = ds.get("train") or ds[list(ds.keys())[0]]

    records: list[dict] = []
    drops: dict[str, int] = {}
    total = 0

    for row in split:
        if args.max_records and total >= args.max_records:
            break
        total += 1
        try:
            rec = _convert_record(dict(row))
        except Exception as exc:
            key = f"error: {type(exc).__name__}"
            drops[key] = drops.get(key, 0) + 1
            continue
        if rec is None:
            drops["filtered"] = drops.get("filtered", 0) + 1
        else:
            records.append(rec)

    slug = OPENCLAW_DATASET.replace("/", "-")
    log.info("%s: total=%d converted=%d dropped=%d", slug, total, len(records), total - len(records))

    if not args.dry_run and records:
        out_path = out_dir / f"{slug}.jsonl"
        n = write_jsonl(records, out_path)
        log.info("Wrote %d records to %s", n, out_path)
    elif args.dry_run:
        log.info("[dry-run] Would write %d records", len(records))

    print(f"\nSummary:")
    print(f"  Total records processed : {total}")
    print(f"  Converted               : {len(records)}")
    print(f"  Dropped                 : {total - len(records)}")
    if drops:
        print("  Drop reasons:")
        for reason, count in sorted(drops.items(), key=lambda x: -x[1]):
            print(f"    {reason}: {count}")


if __name__ == "__main__":
    main()
