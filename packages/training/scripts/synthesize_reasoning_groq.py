#!/usr/bin/env python3
"""Round-1 synth: fill missing `thought:` fields in train.jsonl.

Reads `data/final/train.jsonl`, finds reply / agent_trace / tool_call /
mcp_tool_call records whose expectedResponse lacks a non-empty `thought:`
field, and uses Groq's openai/gpt-oss-120b to synthesize a 1-2 sentence
inner thought for each.

Output: `data/synthesized/manual_reasoning/thoughts.jsonl`
  One line per synthesized record:
    {"key": "<train_jsonl_line_index>", "source": "...", "task_type": "...",
     "thought": "..."}

Resume-safe: re-runs skip keys already present in the output file.

Run:
    GROQ_API_KEY=gsk_... uv run python scripts/synthesize_reasoning_groq.py \
        [--limit N] [--concurrency N] [--max-input-chars N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.groq_thoughts import (  # noqa: E402
    DEFAULT_OUT_FILE,
    HTTPPolicy,
    RoundConfig,
    WorkItem,
    extract_response_text,
    has_thought,
    run_round,
)

TRAIN = ROOT / "data" / "final" / "train.jsonl"

TASKS_WITH_THOUGHT = {"reply", "agent_trace", "tool_call", "mcp_tool_call"}

SYS_PROMPT = (
    "You write the AI assistant's silent first-person inner monologue — the "
    "1-2 sentence thought that runs through its mind right before it sends "
    "the given response.\n\n"
    "Rules (non-negotiable):\n"
    "- First person only. Use 'I', 'my', or no pronouns. NEVER write 'the "
    "agent' or 'the assistant' or 'the response' or 'the reasoning'. Speak "
    "AS the assistant, not ABOUT it.\n"
    "- Under 40 words. One or two sentences.\n"
    "- Explain why this response makes sense given the user's message — "
    "what the user wants, what context matters, what the assistant intends "
    "to convey. Do NOT restate the response.\n"
    "- Never mention 'task', 'prompt', 'instruction', 'reasoning', "
    "'silent', or anything meta about the exercise itself.\n"
    "- Never start with 'Reasoning:' or any label. Output ONLY the thought, "
    "no quotes, no preamble, no trailing notes.\n"
    "- If the user's message is unclear or the response seems off, write the "
    "thought as if the assistant believed its response was helpful — do not "
    "critique the response."
)

BAD_PATTERNS: tuple[str, ...] = (
    r'\bthe agent\b',
    r'\bthe assistant\b',
    r'\bthe (response|reply)\b',
    r'\bthe (reasoning|thought)\b',
    r'\bsilent reasoning\b',
    r'^reasoning\s*:',
    r'\bthe (task|prompt|instruction)\b',
    r'\bActually\b',
    r"\bwe (must|should|need to) (produce|generate|write|output)\b",
)

CFG = RoundConfig(
    system_prompt=SYS_PROMPT,
    bad_patterns=BAD_PATTERNS,
    round_tag=1,
    keep_dirty=False,
    http=HTTPPolicy(
        max_retries=6,
        initial_backoff=1.0,
        backoff_factor=2.0,
        backoff_cap=30.0,
        timeout_s=60.0,
        initial_temperature=0.6,
        temperature_step=0.1,
        temperature_floor=None,  # round-1 bumps temp UP on retry
        max_tokens=250,
    ),
    out_file=DEFAULT_OUT_FILE,
)


def load_seen() -> set[str]:
    seen: set[str] = set()
    if not CFG.out_file.exists():
        return seen
    with CFG.out_file.open() as f:
        for line in f:
            try:
                seen.add(json.loads(line)["key"])
            except (json.JSONDecodeError, KeyError):
                continue
    return seen


def iter_train(limit: int, seen: set[str]) -> tuple[list[WorkItem], int]:
    """Walk train.jsonl and emit WorkItems for records with missing thoughts."""
    items: list[WorkItem] = []
    skipped = 0
    print(f"[scan] reading {TRAIN}", file=sys.stderr)
    with TRAIN.open() as f:
        for idx, line in enumerate(f):
            if limit and len(items) >= limit:
                break
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            tt = rec.get("metadata", {}).get("task_type") or rec.get("task_type") or ""
            if tt not in TASKS_WITH_THOUGHT:
                continue
            er = rec.get("expectedResponse") or ""
            if has_thought(er):
                continue
            key = str(idx)
            if key in seen:
                skipped += 1
                continue
            cm = (rec.get("currentMessage") or {}).get("content", "")
            if not cm:
                continue
            src = rec.get("metadata", {}).get("source_dataset") or "unknown"
            items.append(WorkItem(
                key=key,
                source=src,
                task_type=tt,
                currentMessage=cm,
                response_text=extract_response_text(er),
            ))
    return items, skipped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="Cap on records this run (0 = all)")
    ap.add_argument("--concurrency", type=int, default=24,
                    help="Concurrent in-flight requests")
    ap.add_argument("--max-input-chars", type=int, default=3000,
                    help="Truncate user msg / response to this many chars")
    args = ap.parse_args()

    seen = load_seen()
    print(f"[resume] {len(seen)} already synthesized", file=sys.stderr)

    items, skipped = iter_train(args.limit, seen)
    print(f"[scan] queued {len(items)} records (skipped {skipped})", file=sys.stderr)

    asyncio.run(run_round(
        cfg=CFG, items=items,
        concurrency=args.concurrency,
        max_input_chars=args.max_input_chars,
        progress_label="r1 progress",
    ))


if __name__ == "__main__":
    main()
