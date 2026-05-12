#!/usr/bin/env python3
"""Final cleanup pass — strip "You're welcome!" / "Hello! I'd ..." / generic
greeting+hedge openers when followed by substantive content. Also catches
unquoted text values that earlier regex iterations missed.

These residual cases survive because:
  - Casual detector excludes long user messages that *begin* with "Thanks for
    X, can you Y" — the reply still inherits "You're welcome!" from the model
    template.
  - Earlier regex required exact "happy|glad|pleased" — variants with "love"
    or no verb pattern slipped through.
  - Some records have the opener in unquoted text fields.

Strategy: any reply where the FIRST sentence is a pure social opener
(welcome/greeting/hedge) AND there are ≥2 sentences total → drop the first.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

# A "pure social opener" — first sentence is one of these, leave the rest.
SOCIAL_OPENER_FIRST_SENTENCE = re.compile(
    r"^\s*(?:"
    r"you'?re\s+(?:very\s+|so\s+)?welcome[!.,]?"
    r"|hello[!.,]?\s+i'?d\s+(?:be\s+(?:happy|glad|pleased|delighted)|love)\s+to\s+(?:help|assist)[^.!?]*"
    r"|hi[!.,]?\s+i'?d\s+(?:be\s+(?:happy|glad|pleased|delighted)|love)\s+to\s+(?:help|assist)[^.!?]*"
    r"|hello[!.,]?\s+i\s+can\s+(?:certainly|definitely|absolutely)?\s*help[^.!?]*"
    r"|hi\s+(?:there\s+)?[!.,]?"
    r"|hello\s*[!.,]?"
    r"|hey\s+there[!.,]?"
    r"|good\s+(?:morning|afternoon|evening)[!.,]?"
    r"|certainly[!.,]?"
    r"|absolutely[!.,]?"
    r"|of\s+course[!.,]?"
    r"|sure[!.,]?"
    r"|i'?d\s+be\s+(?:happy|glad|pleased|delighted)\s+to\s+(?:help|assist)[^.!?]*"
    r"|i'?ll\s+(?:gladly|happily)\s+help[^.!?]*"
    r"|happy\s+to\s+help[!.,]?"
    r"|glad\s+to\s+help[!.,]?"
    r"|i\s+can\s+(?:help|assist)\s+(?:you\s+)?with\s+that[!.,]?"
    r"|that'?s\s+a\s+(?:great|good|fantastic|excellent|interesting)\s+question[!.,]?"
    r"|great\s+question[!.,]?"
    r"|interesting\s+question[!.,]?"
    r")\s*[.!?]",
    re.IGNORECASE,
)

# More flexible sentence splitter — also splits on \n
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=\S)|\n+")


def strip_opener_first_sentence(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    # Get first sentence boundary
    m = SOCIAL_OPENER_FIRST_SENTENCE.match(text)
    if not m:
        return text
    rest = text[m.end():].lstrip()
    if not rest:
        return text  # if dropping leaves nothing, keep original
    # Capitalize new lead
    if rest[0].islower():
        rest = rest[0].upper() + rest[1:]
    stats["opener_stripped"] = stats.get("opener_stripped", 0) + 1
    return rest


# Match BOTH quoted and unquoted text values
NATIVE_JSON_TEXT_QUOTED = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
NATIVE_JSON_TEXT_UNQUOTED = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def strip_in_payload(payload: str, stats: dict) -> str:
    def _quoted(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = strip_opener_first_sentence(inner, stats=stats)
        if new_inner == inner:
            return match.group(0)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        new_value = strip_opener_first_sentence(value, stats=stats)
        if new_value == value:
            return match.group(0)
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    new_payload = NATIVE_JSON_TEXT_QUOTED.sub(_quoted, payload)
    new_payload = NATIVE_JSON_TEXT_UNQUOTED.sub(_unquoted, new_payload)
    return new_payload


def transform_record(rec: dict, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply":
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = strip_in_payload(er, stats)
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
