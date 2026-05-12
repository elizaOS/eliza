#!/usr/bin/env python3
"""Strip generic templated lead-ins that appear at the start of substantive
replies, e.g.:

    Based on the information you provided, you are eligible for ...
    → You are eligible for ...

These appear in 2,000+ records (mostly glaive-fc-v2 / sharegpt-tool-calls)
where the model leads with a templated framing before delivering content.
The content is intact after the lead-in is stripped — and the next reader
(human or model) does not need to be told what they just gave the bot.

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

LEAD_INS = [
    re.compile(
        r"^\s*based\s+on\s+the\s+information\s+(?:you\s+(?:provided|gave|shared)|i\s+have)[,.]?\s+",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*based\s+on\s+(?:your\s+(?:input|request|query|message)|what\s+you'?ve\s+(?:provided|told\s+me|shared))[,.]?\s+",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*according\s+to\s+(?:the\s+information\s+)?(?:you\s+(?:provided|gave)|the\s+data\s+(?:provided|given))[,.]?\s+",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*from\s+the\s+(?:information|data|details)\s+(?:you\s+)?(?:provided|gave|shared)[,.]?\s+",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*given\s+the\s+(?:information|data|details)\s+(?:you\s+)?(?:provided|gave|shared)[,.]?\s+",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*using\s+the\s+(?:information|data|details)\s+(?:you\s+)?(?:provided|gave|shared)[,.]?\s+",
        re.IGNORECASE,
    ),
]


def strip_lead(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    original = text
    for i, pat in enumerate(LEAD_INS):
        new_text, n = pat.subn("", text, count=1)
        if n:
            text = new_text
            stats[f"lead{i+1}"] = stats.get(f"lead{i+1}", 0) + 1
            break
    if text != original:
        # Re-capitalize new lead
        if text and text[0].islower():
            text = text[0].upper() + text[1:]
        stats["any_change"] = stats.get("any_change", 0) + 1
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
        new_inner = strip_lead(inner, stats=stats)
        if new_inner == inner:
            return match.group(0)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        new_value = strip_lead(value, stats=stats)
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
