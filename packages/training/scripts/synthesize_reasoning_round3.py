#!/usr/bin/env python3
"""Round-3 synth: target the ~230k records whose `thought:` line is one of
the 9 trivial placeholders. These pass shallow non-empty checks but provide
zero supervised reasoning signal — replace each with a Groq-synthesized
first-person inner thought.

Reads:
  data/synthesized/review/trivial_by_source/*.jsonl
  data/synthesized/manual_reasoning/thoughts.jsonl   (rounds 1+2, append-only)

Writes:
  appends to data/synthesized/manual_reasoning/thoughts.jsonl with `"round": 3`

Resume semantics: a key is "done" only if its existing thought passes
is_clean AND is NOT one of the trivial placeholders. Trivial-thought keys
are always re-synthesized (a previous round may have written the trivial
value back). still_dirty entries always re-queue.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import DEFAULT_THOUGHT_LEAKS  # noqa: E402
from lib.groq_thoughts import (  # noqa: E402
    DEFAULT_OUT_FILE,
    HTTPPolicy,
    RoundConfig,
    WorkItem,
    load_already_done,
    make_is_clean,
    run_round,
)

TRIVIAL_DIR = ROOT / "data" / "synthesized" / "review" / "trivial_by_source"

SYS_PROMPT = (
    "Write a first-person inner thought (1 sentence) explaining WHY you're "
    "about to send this exact response. Frame it as the speaker's brief "
    "mental note before they reply.\n\n"
    "ABSOLUTE RULES:\n"
    "- First person only. Use 'I' or no pronouns.\n"
    "- NEVER use these words: agent, assistant, response, reply, reasoning, "
    "task, prompt, instruction, silent.\n"
    "- Don't say 'the task is complete', 'the task succeeded', or anything "
    "with 'the task'. Instead describe what was done concretely (e.g. "
    "'the file was written', 'the script ran cleanly', 'the build passed').\n"
    "- Under 30 words. Plain sentence. No quotes, no labels, no preamble.\n"
    "- Don't restate the response. Briefly explain motive or context.\n\n"
    "GOOD EXAMPLES:\n"
    "- 'I'll list the available time slots so the user can pick one.'\n"
    "- 'They want a quick fix; I'll show the one-line shell command first.'\n"
    "- 'The script ran cleanly on all three samples, so I'll confirm done.'\n"
    "- 'I need to flag the JSON formatting issue before they re-run it.'\n\n"
    "BAD EXAMPLES (do NOT write):\n"
    "- 'I'll confirm the task is complete.' (uses 'task')\n"
    "- 'The reply explains why ...' (uses 'reply')\n"
    "- 'My response to the user ...' (uses 'response')"
)

BAD_PATTERNS: tuple[str, ...] = (
    r'\b(the\s+)?agent\b',
    r'\b(the\s+)?assistant\b',
    r'\bthe (response|reply|reasoning|task|prompt|instruction)\b',
    r'\bsilent\b',
    r'\bActually\b',
)

TRIVIAL_THOUGHTS = frozenset(DEFAULT_THOUGHT_LEAKS)

CFG = RoundConfig(
    system_prompt=SYS_PROMPT,
    bad_patterns=BAD_PATTERNS,
    round_tag=3,
    trivial_thoughts=TRIVIAL_THOUGHTS,
    keep_dirty=True,
    http=HTTPPolicy(
        max_retries=8,
        initial_backoff=5.0,
        backoff_factor=1.7,
        backoff_cap=60.0,
        timeout_s=90.0,
        initial_temperature=0.7,
        temperature_step=0.1,
        temperature_floor=0.2,
        max_tokens=220,
        extra_headers={"User-Agent": "milady-training/1.0"},
    ),
    out_file=DEFAULT_OUT_FILE,
)


def load_trivial_records() -> list[WorkItem]:
    """Read all per-source trivial dumps and merge into WorkItems."""
    items: list[WorkItem] = []
    for path in sorted(TRIVIAL_DIR.glob("*.jsonl")):
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
                    source=r.get("source") or path.stem,
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
    print(f"[seen] {len(seen)} keys already have clean non-trivial thoughts",
          file=sys.stderr)

    items = load_trivial_records()
    print(f"[load] {len(items)} trivial-record candidates", file=sys.stderr)
    items = [it for it in items if it["key"] not in seen]
    print(f"[load] {len(items)} after de-dup", file=sys.stderr)
    if args.limit:
        items = items[: args.limit]

    asyncio.run(run_round(
        cfg=CFG, items=items,
        concurrency=args.concurrency,
        max_input_chars=args.max_input_chars,
        progress_label="r3 progress",
    ))


if __name__ == "__main__":
    main()
