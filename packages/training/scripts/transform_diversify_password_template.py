#!/usr/bin/env python3
"""Diversify the templated password-generation response.

1,392+ records emit verbatim:

    Here is your new password: <password>. Please make sure to save it in a
    secure place.

This pass detects the template and replaces with a deterministic paraphrase
(md5-seeded by record idx) drawn from a varied pool. The actual password
value is preserved.

Operates in-place on data/final/train_final.jsonl.
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

# Match: "Here is your new password: <pw>. Please make sure to save it in a
# secure place." Capture the password substring so we can preserve it.
TEMPLATE_RE = re.compile(
    r"Here is your new password:\s*(\S+?)\.\s*Please make sure to save it in a secure place\.?",
    re.IGNORECASE,
)

# Paraphrase forms — each takes one positional arg (the password).
PARAPHRASES = [
    "Your new password is: {pw}. Save it somewhere safe.",
    "Here's the password: {pw}. Keep it somewhere secure.",
    "Generated: {pw}. Don't lose it.",
    "Password: {pw}. Store it safely.",
    "New password: {pw}. Save it where you won't lose it.",
    "{pw} — your new password. Keep it safe.",
    "Got it. Password: {pw}. Store somewhere private.",
    "Your password: {pw}. Save it now — I won't store it.",
    "{pw}. That's your password. Save it.",
    "Password generated: {pw}. Stash it somewhere safe.",
    "Here you go: {pw}. Don't share it.",
    "Password is {pw}. Make sure to copy it down.",
    "{pw} — save that.",
    "New one: {pw}. Keep it private.",
    "Done — {pw}. Save it before this scrolls away.",
]


def stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


def diversify(text: str, *, idx: int, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    m = TEMPLATE_RE.search(text)
    if not m:
        return text
    pw = m.group(1)
    template = stable_choice(f"password:{idx}", PARAPHRASES)
    new_phrase = template.format(pw=pw)
    new_text = text[:m.start()] + new_phrase + text[m.end():]
    stats["password_diversified"] = stats.get("password_diversified", 0) + 1
    return new_text


TEXT_QUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TEXT_UNQUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def transform_text_in_toon(toon: str, idx: int, stats: dict) -> str:
    def _quoted(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = diversify(inner, idx=idx, stats=stats)
        if new_inner == inner:
            return match.group(0)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _unquoted(match: re.Match) -> str:
        prefix, key, value = match.groups()
        new_value = diversify(value, idx=idx, stats=stats)
        if new_value == value:
            return match.group(0)
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    new_toon = TEXT_QUOTED_RE.sub(_quoted, toon)
    new_toon = TEXT_UNQUOTED_RE.sub(_unquoted, new_toon)
    return new_toon


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = transform_text_in_toon(er, idx, stats)
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
