#!/usr/bin/env python3
"""Apply deslop transforms to memoryEntries[].content.

Earlier deslop transforms (deslop_assistant, task_reply_deslop,
strip_residual_openers, strip_trailing_offers, diversify_refusals) ran
on expectedResponse only. They missed the memoryEntries field — which
is conversation history that the model conditions on during training.

Audit shows ~10k records with templated 'Hello! I'd be happy to' leads
in memoryEntries, ~8k with 'let me know if' tails. These leak the same
slop the deslop chain removed elsewhere.

This pass applies a focused subset of the same patterns to each
memoryEntries[i].content string:
  - Strip 'Hello! I'd be happy to help' / 'Hi! I'd be happy' lead-ins
  - Strip 'as an AI, I' / "I'm sorry, but I'm" refusal lead-ins
  - Strip 'let me know if you' / 'feel free to' tails
  - Strip 'I don't have the capability' refusal residue
  - Strip <tool_call>/<response> wrappers if any leaked

Operates in-place on data/final/train_final.jsonl.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

LEAD_PATTERNS = [
    re.compile(
        r"^\s*hello!?\s+i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help\s+(?:you\s+)?(?:with\s+[^.!?]+)?[.!?]\s*",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*hi!?\s+i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help\s+(?:you\s+)?(?:with\s+[^.!?]+)?[.!?]\s*",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*(?:I'?m\s+sorry,?\s+)?(?:but\s+)?(?:as\s+an\s+AI,?\s+)?I\s+don'?t\s+have\s+the\s+(?:capability|ability)\s+to\s+[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*(?:that'?s\s+a\s+)?great\s+question[!.,]\s*",
        re.IGNORECASE,
    ),
]

TAIL_PATTERNS = [
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?(?:please\s+)?let\s+me\s+know\s+(?:if|when|how)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?if\s+you\s+(?:have|need|want)\s+(?:any\s+)?(?:other|more|further|additional)\s*(?:questions?|help|info(?:rmation)?|assistance|details?)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?feel\s+free\s+to\s+(?:ask|reach\s+out|message|contact)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?hope\s+(?:this|that)\s+helps?[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?have\s+a\s+(?:great|good|nice|wonderful)\s+(?:day|one|evening|weekend|time)[!.,]?\s*$",
        re.IGNORECASE,
    ),
]

WRAPPER_RE = re.compile(
    r"</?(?:tool_call|response|thought|actions?|providers?)>",
    re.IGNORECASE,
)


def deslop_text(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    original = text
    # Lead strip (one of)
    for pat in LEAD_PATTERNS:
        new_text, n = pat.subn("", text, count=1)
        if n:
            text = new_text
            stats["lead_stripped"] = stats.get("lead_stripped", 0) + 1
            break
    # Re-capitalize
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    # Tail strips (multiple may fire)
    for pat in TAIL_PATTERNS:
        new_text, n = pat.subn("", text)
        if n:
            text = new_text.rstrip()
            if text and text[-1] not in ".!?":
                text += "."
            stats["tail_stripped"] = stats.get("tail_stripped", 0) + 1
    # Strip wrappers if any leaked
    new_text, n = WRAPPER_RE.subn("", text)
    if n:
        text = new_text
        stats["wrappers_stripped"] = stats.get("wrappers_stripped", 0) + 1
    if text != original:
        stats["any_change"] = stats.get("any_change", 0) + 1
    return text if text else original


def transform_record(rec: dict, stats: dict) -> dict:
    me = rec.get("memoryEntries")
    if not isinstance(me, list):
        return rec
    changed = False
    for entry in me:
        if not isinstance(entry, dict):
            continue
        content = entry.get("content")
        if not isinstance(content, str) or not content:
            continue
        new_content = deslop_text(content, stats=stats)
        if new_content != content:
            entry["content"] = new_content
            changed = True
    if changed:
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    stats: dict = {"total": 0, "decode_errors": 0, "records_changed": 0}
    with SRC.open() as fin, tmp.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = transform_record(rec, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 200000 == 0:
                print(f"[{stats['total']}] changed={stats['records_changed']}", file=sys.stderr)
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
