#!/usr/bin/env python3
"""Final pass: diversify ALL standalone "You're welcome!" / "You're welcome."
reply records, regardless of whether the user message classified as "casual".

These slipped earlier passes because users like "No, that's all. Thanks!"
don't start with "thanks" so my casual detector excluded them.

Strategy: any reply task_type record whose entire text field is "You're
welcome!" or "You're welcome." (with optional trailing punctuation) gets a
deterministic paraphrase from the same pool as transform_casual_reply_shorten.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

WELCOME_PARAPHRASES = [
    "Anytime!",
    "Of course!",
    "No problem!",
    "Glad to help!",
    "Happy to help!",
    "Sure thing!",
    "My pleasure!",
    "No worries!",
    "Always.",
    "Don't mention it!",
    "Glad I could help!",
    "Anytime, just ask.",
    "Yeah, no worries.",
    "All good.",
    "Yep.",
    "You bet.",
    "👍",
    "You're welcome!",  # natural, kept at low frequency
    "You're welcome.",
    "🙌",
    "Cheers!",
]

STANDALONE_WELCOME_RE = re.compile(
    r"^\s*you'?re\s+(?:very\s+|so\s+)?welcome[!.,]*\s*$",
    re.IGNORECASE,
)

# Match any text: line (quoted or unquoted)
TEXT_QUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TEXT_UNQUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


def diversify_in_toon(toon: str, idx: int, stats: dict) -> str:
    def _quoted(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        if not STANDALONE_WELCOME_RE.match(inner):
            return match.group(0)
        new_inner = stable_choice(f"standalone_welcome:{idx}", WELCOME_PARAPHRASES)
        if new_inner == inner:
            return match.group(0)
        stats["diversified"] = stats.get("diversified", 0) + 1
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        if not STANDALONE_WELCOME_RE.match(value):
            return match.group(0)
        new_value = stable_choice(f"standalone_welcome:{idx}", WELCOME_PARAPHRASES)
        if new_value == value:
            return match.group(0)
        stats["diversified"] = stats.get("diversified", 0) + 1
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    new_toon = TEXT_QUOTED_RE.sub(_quoted, toon)
    new_toon = TEXT_UNQUOTED_RE.sub(_unquoted, new_toon)
    return new_toon


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply":
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = diversify_in_toon(er, idx, stats)
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
        for idx, line in enumerate(fin):
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = transform_record(rec, idx, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 200000 == 0:
                print(f"[{stats['total']}] changed={stats['records_changed']}", file=sys.stderr)
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
