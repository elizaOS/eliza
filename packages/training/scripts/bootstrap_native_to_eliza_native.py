#!/usr/bin/env python3
"""Convert bootstrap native-tool rows to final `eliza_native_v1` rows.

`prepare_native_tool_calling_data.py` audits and normalizes heterogeneous
datasets into `eliza.native_tool_calling.v1` bootstrap rows. Training consumes
only `eliza_native_v1`: one Vercel AI SDK model-boundary row with `request`
and `response`. This converter is the narrow bridge between those two shapes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

BOOTSTRAP_SCHEMA = "eliza.native_tool_calling.v1"
FINAL_FORMAT = "eliza_native_v1"
INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}


def stable_id(*parts: Any) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, sort_keys=True, default=str).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()[:24]


def as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def iter_input_files(paths: Iterable[str]) -> Iterable[Path]:
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in INPUT_SUFFIXES:
                    yield child
        else:
            yield path


def expand_top_level(value: Any) -> Iterable[Any]:
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


def read_json_records(path: Path) -> Iterable[Any]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return
    if text[0] in "[{":
        try:
            yield from expand_top_level(json.loads(text))
            return
        except json.JSONDecodeError:
            pass
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            yield from expand_top_level(json.loads(line))
        except json.JSONDecodeError as exc:
            print(f"skip invalid JSON {path}:{line_no}: {exc}", file=sys.stderr)


def stage_to_task_type(stage: str) -> str:
    if stage == "message_handler":
        return "should_respond"
    if stage in {"planner", "sub_planner"}:
        return "action_planner"
    if stage == "evaluator":
        return "evaluator"
    return stage or "response"


def normalize_tool_call(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = raw.get("toolName") or raw.get("name")
    if not isinstance(name, str) or not name:
        return None
    args = raw.get("input") if "input" in raw else raw.get("args", {})
    return {
        "toolCallId": str(raw.get("toolCallId") or raw.get("id") or f"call_{index}"),
        "toolName": name,
        "input": args if isinstance(args, dict) else {"value": args},
    }


def output_to_response(stage: str, output: dict[str, Any]) -> dict[str, Any] | None:
    if stage in {"planner", "sub_planner"}:
        planner = as_record(output.get("planner"))
        if not planner:
            return None
        calls = [
            call
            for i, raw in enumerate(planner.get("toolCalls") or [])
            if (call := normalize_tool_call(raw, i)) is not None
        ]
        text = planner.get("text")
        response: dict[str, Any] = {"text": text if isinstance(text, str) else ""}
        if calls:
            response["toolCalls"] = calls
        if isinstance(planner.get("finishReason"), str):
            response["finishReason"] = planner["finishReason"]
        elif calls:
            response["finishReason"] = "tool-calls"
        return response if response["text"] or response.get("toolCalls") else None

    if stage == "message_handler":
        value = as_record(output.get("messageHandler"))
        if not value:
            return None
        return {"text": json.dumps({"messageHandler": value}, ensure_ascii=False, sort_keys=True)}

    if stage == "evaluator":
        value = as_record(output.get("evaluation"))
        if not value:
            return None
        return {"text": json.dumps({"evaluation": value}, ensure_ascii=False, sort_keys=True)}

    if stage == "trajectory":
        value = as_record(output.get("trajectory"))
        if not value:
            return None
        return {"text": json.dumps({"trajectory": value}, ensure_ascii=False, sort_keys=True)}

    return None


def convert_row(row: Any) -> dict[str, Any] | None:
    rec = as_record(row)
    if not rec or rec.get("schema") != BOOTSTRAP_SCHEMA:
        return None
    stage = str(rec.get("stage") or "")
    source = as_record(rec.get("source")) or {}
    output = as_record(rec.get("output")) or {}
    response = output_to_response(stage, output)
    if response is None:
        return None

    messages = rec.get("messages")
    request: dict[str, Any] = {}
    if isinstance(messages, list) and messages:
        request["messages"] = messages
    prompt = (as_record(rec.get("input")) or {}).get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        request["prompt"] = prompt
    if not request:
        return None
    if rec.get("tools") is not None:
        request["tools"] = rec["tools"]
    if stage == "message_handler":
        request.setdefault("toolChoice", "required")
    elif stage in {"planner", "sub_planner"} and rec.get("tools"):
        request.setdefault("toolChoice", "auto")

    row_id = str(rec.get("id") or stable_id(source, stage, request, response))
    return {
        "format": FINAL_FORMAT,
        "schemaVersion": 1,
        "boundary": "vercel_ai_sdk.generateText",
        "trajectoryId": f"bootstrap:{source.get('dataset', 'unknown')}",
        "agentId": "bootstrap-dataset",
        "source": "bootstrap_native_dataset",
        "status": "completed",
        "stepId": row_id,
        "callId": row_id,
        "stepIndex": 0,
        "callIndex": 0,
        "timestamp": 0,
        "purpose": stage_to_task_type(stage),
        "stepType": stage,
        "model": None,
        "modelType": None,
        "provider": None,
        "request": request,
        "response": response,
        "metadata": {
            "task_type": stage_to_task_type(stage),
            "source_dataset": source.get("dataset", "bootstrap_native_dataset"),
            "source_schema": BOOTSTRAP_SCHEMA,
            "source_id": row_id,
            "source_conversion": source.get("conversion"),
            "source_normalizer": source.get("normalizer"),
            "source_license": source.get("license"),
        },
        "trajectoryTotals": {
            "stepCount": 1,
            "llmCallCount": 1,
            "providerAccessCount": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "cacheReadInputTokens": 0,
            "cacheCreationInputTokens": 0,
        },
        "cacheStats": {
            "totalInputTokens": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "cacheReadInputTokens": 0,
            "cacheCreationInputTokens": 0,
            "cachedCallCount": 0,
            "cacheReadCallCount": 0,
            "cacheWriteCallCount": 0,
            "tokenUsageEstimatedCallCount": 0,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", type=int, default=0)
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    skipped = 0
    for path in iter_input_files(args.input):
        for raw in read_json_records(path):
            row = convert_row(raw)
            if row is None:
                skipped += 1
                continue
            rows.append(row)
            if args.max_records and len(rows) >= args.max_records:
                break
        if args.max_records and len(rows) >= args.max_records:
            break

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
    print(json.dumps({"format": FINAL_FORMAT, "rows": len(rows), "skipped": skipped, "output": str(out)}, indent=2))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
