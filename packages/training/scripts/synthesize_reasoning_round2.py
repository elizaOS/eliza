#!/usr/bin/env python3
"""Round-2 synth: target the 11,841 empty records that round-1 missed.

Reads:
  data/synthesized/review/empty_by_source/*.jsonl
  data/synthesized/manual_reasoning/thoughts.jsonl  (round-1 results, append-only)

Writes:
  appends to data/synthesized/manual_reasoning/thoughts.jsonl with `"round": 2`

Differences from round-1:
- Stricter prompt (forbids 3rd-person words in ALL caps, gives examples).
- Aggressive truncation (1500 chars input, 800 chars response).
- Longer backoff (5s base, up to 60s) — handles cloudflare 1010 / 5xx.
- Higher max_tokens budget for reasoning.
- 8 retries; temperature steps DOWN on retry to encourage cleaner output.
- "still_dirty" attempts are persisted so we can audit reject reasons.
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
    load_already_done,
    make_is_clean,
    run_round,
)

EMPTY_DIR = ROOT / "data" / "synthesized" / "review" / "empty_by_source"

SYS_PROMPT = (
    "Write the AI assistant's silent first-person inner thought (1 sentence) "
    "right before sending the response.\n\n"
    "ABSOLUTE RULES:\n"
    "- ONLY first person. Use 'I' or no pronouns.\n"
    "- NEVER use the words: 'agent', 'assistant', 'response', 'reply', "
    "'reasoning', 'task', 'prompt', 'instruction', 'silent'.\n"
    "- Under 30 words. Plain sentence. No quotes, no labels, no preamble.\n"
    "- Don't restate the response. Briefly explain why I'm answering this way.\n\n"
    "EXAMPLES:\n"
    "- 'I'll list the available time slots so the user can pick one.'\n"
    "- 'They want a quick fix; I'll show the one-line shell command first.'\n"
    "- 'Need to confirm the file write succeeded before suggesting the next step.'"
)

BAD_PATTERNS: tuple[str, ...] = (
    r'\b(the\s+)?agent\b',
    r'\b(the\s+)?assistant\b',
    r'\bthe (response|reply|reasoning|task|prompt|instruction)\b',
    r'\bsilent\b',
    r'\bActually\b',
)

CFG = RoundConfig(
    system_prompt=SYS_PROMPT,
    bad_patterns=BAD_PATTERNS,
    round_tag=2,
    keep_dirty=True,
    http=HTTPPolicy(
        max_retries=8,
        initial_backoff=5.0,
        backoff_factor=1.7,
        backoff_cap=60.0,
        timeout_s=90.0,
        initial_temperature=0.7,
        temperature_step=0.1,
        temperature_floor=0.2,  # round-2 lowers temperature on retry
        max_tokens=220,
        extra_headers={"User-Agent": "eliza-training/1.0"},
    ),
    out_file=DEFAULT_OUT_FILE,
)


def load_empty_records() -> list[WorkItem]:
    """Read all per-source empty dumps and merge into WorkItems."""
    items: list[WorkItem] = []
    for path in sorted(EMPTY_DIR.glob("*.jsonl")):
        with path.open() as f:
            for line in f:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = r.get("key")
                if not key:
                    continue
                items.append(WorkItem(
                    key=key,
                    source=path.stem,
                    task_type=r.get("task_type") or "",
                    currentMessage=r.get("currentMessage_preview") or "",
                    response_text=r.get("expectedResponse_preview") or "",
                ))
    return items


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--max-input-chars", type=int, default=1500)
    args = ap.parse_args()

    is_clean = make_is_clean(CFG)
    seen = load_already_done(CFG, is_clean=is_clean)
    print(f"[seen] {len(seen)} keys already have clean thoughts", file=sys.stderr)

    items = load_empty_records()
    print(f"[load] {len(items)} empty-record candidates", file=sys.stderr)
    items = [it for it in items if it["key"] not in seen]
    print(f"[load] {len(items)} after de-dup", file=sys.stderr)
    if args.limit:
        items = items[: args.limit]

    asyncio.run(run_round(
        cfg=CFG, items=items,
        concurrency=args.concurrency,
        max_input_chars=args.max_input_chars,
        progress_label="r2 progress",
    ))


if __name__ == "__main__":
    main()
