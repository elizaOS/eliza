#!/usr/bin/env python3
"""Strip trailing 'let me know if...', 'feel free to...', 'hope this helps',
'have a great day' and similar offer/farewell tails from ANY task_type's
text: field.

Earlier deslop transforms (transform_task_reply_deslop, transform_unquoted_text_deslop)
filtered to task_type == 'reply' only and skipped the ~217k agent_trace
records, which often have these trails inside their REPLY action text.

This pass is task-type-agnostic. It strips trailing offers from every
text: field in every record's expectedResponse.

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
        r"\s*(?:[-–—.!?]\s+)?happy\s+to\s+(?:help|assist|chat)\s+(?:further|more|again|with)[^.!?]*[.!?]?\s*$",
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
    re.compile(
        r"\s*(?:[-–—.!?]\s+)?reach\s+out\s+anytime[!.,]?\s*$",
        re.IGNORECASE,
    ),
]

# Trailing dangling separator (e.g. " - please." after we strip "please let me know if X.")
DANGLING_RE = re.compile(r"\s*[-–—,]\s*(?:please|so)?\s*[.!?]?\s*$", re.IGNORECASE)


def strip_tail(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    original = text
    for pat in TAIL_PATTERNS:
        new_text, n = pat.subn("", text)
        if n:
            text = new_text.rstrip()
            if text and text[-1] not in ".!?":
                text += "."
            stats["tail_stripped"] = stats.get("tail_stripped", 0) + 1
    # Clean up trailing dangling separators left after stripping
    if text != original:
        new_text, n = DANGLING_RE.subn(".", text)
        if n:
            text = new_text
    return text if text else original


TEXT_QUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TEXT_UNQUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def transform_text_in_toon(toon: str, stats: dict) -> str:
    def _quoted(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = strip_tail(inner, stats=stats)
        if new_inner == inner:
            return match.group(0)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        new_value = strip_tail(value, stats=stats)
        if new_value == value:
            return match.group(0)
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    new_toon = TEXT_QUOTED_RE.sub(_quoted, toon)
    new_toon = TEXT_UNQUOTED_RE.sub(_unquoted, new_toon)
    return new_toon


def transform_record(rec: dict, stats: dict) -> dict:
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = transform_text_in_toon(er, stats)
    if new_er != er:
        rec["expectedResponse"] = new_er
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
