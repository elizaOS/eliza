#!/usr/bin/env python3
"""Build local SFT splits from runtime trajectory exports.

Accepted inputs:
  - `trajectory_harness_v1` JSONL rows from trajectory export
  - app-training / Gemini-style rows with `messages`
  - legacy trajectory detail JSON/JSONL with `steps[].llmCalls[]`

Output rows intentionally use the same `messages + metadata` envelope for all
inputs. `format_for_training.py` renders that shape directly, so trajectory
data and the canonical ElizaRecord corpus flow through one chat-template path.
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

ROOT = Path(__file__).resolve().parent.parent

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("trajectories-to-sft")

Message = dict[str, str]
Example = dict[str, Any]

INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _message_role(role: Any) -> str | None:
    if not isinstance(role, str):
        return None
    normalized = role.strip().lower()
    if normalized == "model":
        return "assistant"
    if normalized in {"system", "user", "assistant"}:
        return normalized
    return None


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
        for key in ("trajectories", "records", "examples", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from nested
                return
        trajectory = value.get("trajectory")
        if isinstance(trajectory, dict):
            yield trajectory
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


def _normalize_messages(raw_messages: Any) -> list[Message] | None:
    if not isinstance(raw_messages, list):
        return None

    messages: list[Message] = []
    for raw in raw_messages:
        record = _as_record(raw)
        if not record:
            continue
        role = _message_role(record.get("role"))
        content = _clean(record.get("content"))
        if role and content:
            messages.append({"role": role, "content": content})

    if not messages:
        return None
    if messages[-1]["role"] != "assistant":
        return None
    if not any(message["role"] == "user" for message in messages):
        return None
    return messages


def _parse_json_object(text: str) -> dict[str, Any] | None:
    trimmed = text.strip()
    if trimmed.startswith("```"):
        trimmed = trimmed.replace("```json", "", 1).replace("```", "", 1).strip()
        if trimmed.endswith("```"):
            trimmed = trimmed[:-3].strip()
    if not trimmed.startswith("{"):
        return None
    try:
        parsed = json.loads(trimmed)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _looks_like_message_handler(response: str) -> bool:
    parsed = _parse_json_object(response)
    if not parsed:
        return False
    candidate = parsed.get("messageHandler")
    if isinstance(candidate, dict):
        return candidate.get("action") in {"RESPOND", "IGNORE", "STOP"}
    return (
        parsed.get("action") in {"RESPOND", "IGNORE", "STOP"}
        and isinstance(parsed.get("contexts"), list)
    )


def _looks_like_planner(response: str) -> bool:
    parsed = _parse_json_object(response)
    if parsed and isinstance(parsed.get("actions"), list):
        return True
    return "actions:" in response or "\nactions[" in response


def infer_task_type(record: dict[str, Any]) -> str:
    metadata = _as_record(record.get("metadata")) or {}
    explicit = _clean(metadata.get("task_type") or metadata.get("taskType"))
    if explicit:
        return explicit

    tokens: list[str] = []
    for key in ("purpose", "actionType", "stepType", "modelSlot"):
        value = _clean(record.get(key))
        if value:
            tokens.append(value.lower())
    tags = record.get("tags")
    if isinstance(tags, list):
        tokens.extend(_clean(tag).lower() for tag in tags if _clean(tag))

    token_text = " ".join(tokens).replace("-", "_")
    response = _as_str(record.get("response"))

    if "context_routing" in token_text:
        return "context_routing"
    if (
        "should_respond" in token_text
        or "response_handler" in token_text
        or _looks_like_message_handler(response)
    ):
        return "should_respond"
    if any(part in token_text for part in ("action_planner", "planner", "runtime_use_model")):
        return "action_planner"
    if _looks_like_planner(response):
        return "action_planner"
    if any(part in token_text for part in ("media_description", "describe_image", "describe_audio")):
        return "media_description"
    if any(part in token_text for part in ("reply", "response", "message_response")):
        return "reply"
    return "response"


def _metadata_for(record: dict[str, Any], *, task_type: str) -> dict[str, Any]:
    base = _as_record(record.get("metadata")) or {}
    metadata: dict[str, Any] = {
        **base,
        "task_type": task_type,
        "source_dataset": base.get("source_dataset") or "runtime_trajectories",
    }
    for src, dest in (
        ("trajectoryId", "trajectory_id"),
        ("callId", "call_id"),
        ("stepId", "step_id"),
        ("agentId", "agent_id"),
        ("source", "trajectory_source"),
        ("purpose", "source_call_purpose"),
        ("actionType", "source_action_type"),
        ("stepType", "source_step_type"),
        ("model", "source_model"),
    ):
        value = record.get(src)
        if value is not None and dest not in metadata:
            metadata[dest] = value
    return metadata


def _example_from_messages_record(record: dict[str, Any]) -> Example | None:
    messages = _normalize_messages(record.get("messages"))
    if not messages:
        return None
    task_type = infer_task_type(record)
    return {"messages": messages, "metadata": _metadata_for(record, task_type=task_type)}


def _messages_from_call(call: dict[str, Any]) -> list[Message] | None:
    messages = _normalize_messages(call.get("messages"))
    if messages:
        return messages

    system_prompt = _clean(call.get("systemPrompt"))
    user_prompt = _clean(call.get("userPrompt"))
    response = _clean(call.get("response"))
    if not system_prompt or not user_prompt or not response:
        return None
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
        {"role": "assistant", "content": response},
    ]


def _examples_from_legacy_trajectory(record: dict[str, Any]) -> Iterable[Example]:
    trajectory_id = _clean(record.get("trajectoryId"))
    agent_id = _clean(record.get("agentId"))
    source = _clean(record.get("source")) or _clean((_as_record(record.get("metadata")) or {}).get("source"))
    steps = record.get("steps")
    if not isinstance(steps, list):
        steps_json = record.get("stepsJson")
        if isinstance(steps_json, str) and steps_json.strip():
            try:
                parsed_steps = json.loads(steps_json)
                steps = parsed_steps if isinstance(parsed_steps, list) else []
            except json.JSONDecodeError:
                steps = []
        else:
            steps = []

    for step_index, step in enumerate(steps):
        step_record = _as_record(step)
        if not step_record:
            continue
        step_id = _clean(step_record.get("stepId")) or f"{trajectory_id}:step:{step_index + 1}"
        calls = step_record.get("llmCalls")
        if not isinstance(calls, list):
            continue
        for call_index, call in enumerate(calls):
            call_record = _as_record(call)
            if not call_record:
                continue
            enriched = {
                **call_record,
                "trajectoryId": trajectory_id,
                "agentId": agent_id,
                "source": source,
                "stepId": step_id,
                "callId": _clean(call_record.get("callId")) or f"{step_id}:call:{call_index + 1}",
            }
            messages = _messages_from_call(enriched)
            if not messages:
                continue
            task_type = infer_task_type(enriched)
            yield {
                "messages": messages,
                "metadata": _metadata_for(enriched, task_type=task_type),
            }


def examples_from_record(record: Any) -> Iterable[Example]:
    rec = _as_record(record)
    if not rec:
        return
    direct = _example_from_messages_record(rec)
    if direct:
        yield direct
        return
    if isinstance(rec.get("steps"), list) or isinstance(rec.get("stepsJson"), str):
        yield from _examples_from_legacy_trajectory(rec)


def _example_id(example: Example, index: int) -> str:
    metadata = _as_record(example.get("metadata")) or {}
    return "|".join(
        _clean(metadata.get(key))
        for key in ("trajectory_id", "step_id", "call_id", "task_type")
    ) or str(index)


def _write_jsonl(path: Path, rows: list[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", action="append", required=True, help="JSON/JSONL file or directory. Repeatable.")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--val-ratio", type=float, default=0.05)
    ap.add_argument("--test-ratio", type=float, default=0.05)
    ap.add_argument("--seed", default="eliza-trajectory-sft-v1")
    ap.add_argument("--max-records", type=int, default=0)
    ap.add_argument(
        "--tasks",
        default="",
        help="Optional comma-separated task_type allowlist after inference.",
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
        "schema": "eliza.trajectory_sft_splits.v1",
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
