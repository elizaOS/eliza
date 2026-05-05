#!/usr/bin/env python3
"""Fix the bug introduced by running transform_diversify_refusals multiple times:
when v2/v3 hit a record that v1 already prefixed with a paraphrase, the
matching refusal-pattern strips the templated remainder but the paraphrase
gets prepended a SECOND time (same idx → same stable_choice). Result:

    "Anytime! Anytime! In this case, I can help you ..."
    "I can only call the tools provided, and none of them fit. I can only
     call the tools provided, and none of them fit. In this case, ..."

This pass removes any case where any paraphrase appears twice consecutively
(separated only by sentence whitespace) at the start of a text: field.

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

PARAPHRASES = [
    "I can't do that — none of the available tools match the request.",
    "That's outside what my tools can do.",
    "No tool here covers that.",
    "Sorry, no tool I've been given handles that.",
    "I don't have a way to do that with the tools listed.",
    "The tool catalog doesn't include that capability.",
    "That's beyond what I can do with the current toolset.",
    "Not in my available tools — can't help with that.",
    "None of the listed tools fit this task.",
    "I'd need a tool for that, and I don't have one.",
    "No matching tool. Can't proceed.",
    "Nothing in the toolset handles this.",
    "That request needs a tool I don't have.",
    "Out of scope for the tools provided.",
    "None of my tools can do that.",
    "Can't do that one — no relevant tool.",
    "No tool match for that request.",
    "I'd need a different tool — this one isn't in the list.",
    "I can only call the tools provided, and none of them fit.",
    "Outside the tools I can call.",
]

# Match a duplicated paraphrase pattern. Two forms:
#   1. "P. P." — direct duplicate, separated by whitespace
#   2. "P. \"P.\"" — duplicate where the second copy is wrapped in inner
#      escaped quotes (this arises when v2/v3 ran on a record whose v1
#      paraphrase was already inside a JSON-quoted text: value, then v2
#      stripped the templated remainder and prepended the v1 paraphrase
#      again).
#
# Replacement: just \1 (single paraphrase). Important: do NOT consume the
# outer closing quote that delimits the text: value. The trailing
# `\\?["']?` matches *at most one* inner-quote character — enough for the
# escaped form, but not enough to eat the outer text: closing quote.
escaped = [re.escape(p) for p in PARAPHRASES]
DUP_RE = re.compile(
    r"(" + "|".join(escaped) + r')\s*\\?["\']?\1\\?["\']?',
    re.DOTALL,
)


def dedup(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    new_text = text
    while True:
        new_text2, n = DUP_RE.subn(r"\1", new_text)
        if not n:
            break
        new_text = new_text2
        stats["dedup_pass"] = stats.get("dedup_pass", 0) + 1
    return new_text


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
        new_inner = dedup(inner, stats=stats)
        if new_inner == inner:
            return match.group(0)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        new_value = dedup(value, stats=stats)
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
