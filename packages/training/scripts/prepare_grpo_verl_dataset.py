"""Prepare canonical elizaOS training rows for verl GRPO consumption.

The SFT handoff keeps the supervised assistant response in each source row.
verl instead needs a prompt-only message list plus explicit reward ground truth,
so this adapter separates those surfaces without changing the tracked corpus.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from format_for_training import format_record


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _prompt_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if content is not None:
            return json.dumps(content, ensure_ascii=False, sort_keys=True)
    return ""


def _prompt_with_tool_context(
    messages: list[dict[str, Any]], tools: Any
) -> list[dict[str, Any]]:
    """Preserve native tool schemas for verl's single-turn rollout loop."""

    prompt = [dict(message) for message in messages]
    if tools is None or tools == [] or tools == {}:
        return prompt

    tool_context = "Available tools (JSON):\n" + json.dumps(
        tools, ensure_ascii=False, sort_keys=True
    )
    if prompt and prompt[0].get("role") == "system":
        existing = prompt[0].get("content")
        if not isinstance(existing, str):
            raise ValueError(
                "system message content must be text when tools are present"
            )
        prompt[0]["content"] = existing.rstrip() + "\n\n" + tool_context
    else:
        prompt.insert(0, {"role": "system", "content": tool_context})
    return prompt


def convert_record(record: dict[str, Any]) -> dict[str, Any]:
    """Convert one supported corpus row into verl's RLHFDataset contract."""

    # format_record is also the mandatory privacy-filter chokepoint. Do not add
    # a pass-through format here: every rollout prompt must cross that boundary.
    formatted = format_record(record)
    if formatted is None:
        raise ValueError("row is not compatible with the canonical training formatter")

    messages = formatted.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        raise ValueError("formatted row must contain a prompt and assistant target")
    assistant = messages[-1]
    if not isinstance(assistant, dict) or assistant.get("role") != "assistant":
        raise ValueError("formatted row must end in an assistant target")

    prompt = _prompt_with_tool_context(messages[:-1], formatted.get("tools"))
    if not any(
        isinstance(message, dict) and message.get("role") == "user"
        for message in prompt
    ):
        raise ValueError("formatted prompt must contain a user message")

    ground_truth: dict[str, Any] = {}
    content = assistant.get("content")
    if isinstance(content, str) and content.strip():
        ground_truth["expected"] = content
    tool_calls = assistant.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        ground_truth["expectedToolCalls"] = tool_calls
    if not ground_truth:
        raise ValueError("assistant target contains neither text nor tool calls")

    metadata = _as_dict(record.get("metadata"))
    data_source = (
        metadata.get("task_type")
        or metadata.get("source_dataset")
        or record.get("schema")
        or record.get("format")
        or "eliza"
    )
    return {
        "prompt": prompt,
        "data_source": str(data_source),
        "reward_model": {"ground_truth": ground_truth},
        "extra_info": {"prompt": _prompt_text(prompt)},
    }


def prepare_dataset(source: Path, destination: Path) -> int:
    """Stream-convert a JSONL corpus and return the number of written rows."""

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.with_suffix(destination.suffix + ".tmp")
    written = 0
    with source.open("r", encoding="utf-8") as input_handle, staging.open(
        "w", encoding="utf-8"
    ) as output_handle:
        for line_number, line in enumerate(input_handle, start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except (
                json.JSONDecodeError
            ) as exc:  # error-policy:J2 Add source-row context.
                raise ValueError(f"{source}:{line_number}: invalid JSON") from exc
            if not isinstance(raw, dict):
                raise ValueError(f"{source}:{line_number}: row must be a JSON object")
            try:
                converted = convert_record(raw)
            except (
                TypeError,
                ValueError,
            ) as exc:  # error-policy:J2 Add source-row context.
                raise ValueError(f"{source}:{line_number}: {exc}") from exc
            output_handle.write(
                json.dumps(converted, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            written += 1

    if written == 0:
        raise ValueError(f"{source}: no trainable GRPO rows")
    staging.replace(destination)
    return written


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    written = prepare_dataset(args.source, args.output)
    print(f"prepared {written} verl GRPO rows: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
