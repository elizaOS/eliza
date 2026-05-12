#!/usr/bin/env python3
"""Strip wrapper tokens from memoryEntries[*].content and currentMessage.content.

Companion to `transform_corpus_cleanup.py` (which strips wrappers from
expectedResponse only). Targets <|endoftext|>, <answer>, <think>...</think>,
<tool_call>...</tool_call> in input fields the first pass missed.

Reads:  data/final/train_cleaned_pre_memoryentries.jsonl
Writes: data/final/train_cleaned.jsonl
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_cleaned_pre_memoryentries.jsonl"
DST = ROOT / "data" / "final" / "train_cleaned.jsonl"
MANIFEST = ROOT / "data" / "final" / "manifest_cleaned.json"

ENDOFTEXT = "<|endoftext|>"
ANSWER_TAGS_RE = re.compile(r"</?answer>")
THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
TOOLCALL_BLOCK_RE = re.compile(r"<tool_call>.*?</tool_call>", re.DOTALL)


def strip_wrappers(s: str) -> tuple[str, bool]:
    if not isinstance(s, str) or not s:
        return s, False
    original = s
    s = s.replace(ENDOFTEXT, "")
    s = ANSWER_TAGS_RE.sub("", s)
    s = THINK_BLOCK_RE.sub("", s)
    s = TOOLCALL_BLOCK_RE.sub("", s)
    return s, s != original


def clean_record(rec: dict, stats: dict) -> dict:
    cm = rec.get("currentMessage")
    if isinstance(cm, dict):
        c = cm.get("content")
        if isinstance(c, str):
            new_c, changed = strip_wrappers(c)
            if changed:
                cm["content"] = new_c
                stats["currentMessage_stripped"] += 1

    mems = rec.get("memoryEntries")
    if isinstance(mems, list):
        memory_changed = False
        for m in mems:
            if not isinstance(m, dict):
                continue
            c = m.get("content")
            if isinstance(c, str):
                new_c, changed = strip_wrappers(c)
                if changed:
                    m["content"] = new_c
                    memory_changed = True
        if memory_changed:
            stats["memoryEntries_stripped"] += 1

    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing — run transform_corpus_cleanup.py first", file=sys.stderr)
        return 2

    stats = {
        "total": 0,
        "currentMessage_stripped": 0,
        "memoryEntries_stripped": 0,
        "decode_errors": 0,
    }
    print(f"[gap-patch] {SRC} -> {DST}", file=sys.stderr)
    with SRC.open() as fin, DST.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = clean_record(rec, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 100000 == 0:
                print(
                    f"[gap-patch] {stats['total']:>7d}  "
                    f"cm_stripped={stats['currentMessage_stripped']:>6d}  "
                    f"mem_stripped={stats['memoryEntries_stripped']:>6d}",
                    file=sys.stderr,
                )

    MANIFEST.write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
