#!/usr/bin/env python3
"""Diversify the templated AI-refusal slop.

10,586 records (≈10k from glaive-fc-v2, sharegpt-tool-calls, tool-reasoning-
coding-nemotron, openclaw-operator) emit verbatim:

    I'm sorry, but as an AI, I don't have the capability to perform external
    tasks such as ordering a pizza. My current capabilities are limited to
    the functions provided to me.

This pass detects the canonical refusal templates and rewrites them with a
deterministic paraphrase (md5-seeded by record index) drawn from a varied pool.

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

# Match canonical refusal templates. Each pattern is a single sentence-cluster
# that says "I can't because no tool fits". Patterns are tried in order; the
# first match strips the cluster.
REFUSAL_PATTERNS = [
    # "(I'm sorry, but) (as an AI,) I don't have the (capability|ability) to ..."
    re.compile(
        r"(?:I'?m\s+sorry,?\s+)?(?:but\s+)?(?:as\s+an\s+AI,?\s+)?I\s+don'?t\s+have\s+the\s+(?:capability|ability|tools?|functionality)\s+to\s+[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "I'm (sorry/afraid), (but) I'm unable to (assist|perform|help) ..."
    re.compile(
        r"(?:I'?m\s+(?:sorry|afraid),?\s+)?(?:but\s+)?I'?m\s+(?:unable|not\s+able)\s+to\s+(?:assist|help|perform|do|provide)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "I'm sorry, I can't (assist|help|do|perform) ..."
    re.compile(
        r"I'?m\s+sorry,?\s+(?:but\s+)?I\s+can'?t\s+(?:assist|help|do|perform|provide)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "My current capabilities (are limited to|don't include) ..."
    re.compile(
        r"My\s+current\s+capabilities\s+(?:are\s+limited\s+to|don'?t\s+include|do\s+not\s+include)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "My current function (allows|permits) me to ..."
    re.compile(
        r"My\s+current\s+function\s+(?:allows|permits|enables)\s+me\s+to[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "Based on the (available|provided) (API|tools|functions), I can only ..."
    re.compile(
        r"Based\s+on\s+the\s+(?:available|provided|given)\s+(?:API|tools?|functions?|capabilities)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "(I am|I'm) limited to the functions (provided|available) (to me) ..."
    re.compile(
        r"(?:I\s+am|I'?m)\s+limited\s+to\s+the\s+(?:functions?|tools?)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "I'm currently unable to perform/do/help ..."
    re.compile(
        r"I'?m\s+currently\s+(?:unable|not\s+able)\s+to\s+(?:perform|do|help|assist|handle|provide)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "That's beyond what I can do ..."
    re.compile(
        r"That'?s\s+beyond\s+what\s+I\s+can\s+(?:do|handle|process)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "My main function is to assist ... based on the functions provided ..."
    re.compile(
        r"My\s+main\s+function\s+is\s+to\s+assist[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "My capabilities are currently limited to ..."
    re.compile(
        r"My\s+capabilities\s+are\s+currently\s+limited\s+to[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "Apologies, but ... not (within|in|part of) my capabilities ..."
    re.compile(
        r"Apologies,?\s+(?:but\s+)?[^.!?]*(?:not\s+(?:within|in|part\s+of)\s+my\s+capabilit|outside\s+(?:of\s+)?my\s+capabilit)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
    # "If you have any other (questions|requests), feel free ..."
    re.compile(
        r"If\s+you\s+have\s+any\s+other\s+(?:questions?|requests?|inquiries?|needs?)[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ),
]

# Compact paraphrases — varied register (terse + verbose, formal + casual).
# Each preserves the core meaning ("I can't, no tool matches") without
# dragging in "as an AI" boilerplate.
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


def stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


# Trigger phrase to detect the slop family. If none of these are present,
# skip — saves time on the 90% of records that aren't refusals.
TRIGGER_RE = re.compile(
    r"(?:"
    r"i\s+don'?t\s+have\s+the\s+(?:capability|ability|tools?|functionality)"
    r"|as\s+an\s+ai\s+i"
    r"|i'?m\s+(?:sorry|afraid|unable)\s+(?:but|to)"
    r"|i'?m\s+sorry,?\s+(?:but\s+)?i\s+can'?t"
    r"|my\s+current\s+(?:capabilities|function)"
    r"|based\s+on\s+the\s+(?:available|provided|given)\s+(?:api|tools?|functions?)"
    r"|i\s+am\s+limited\s+to\s+the\s+(?:functions?|tools?)"
    r"|i'?m\s+limited\s+to\s+the\s+(?:functions?|tools?)"
    r"|i'?m\s+currently\s+(?:unable|not\s+able)"
    r"|that'?s\s+beyond\s+what\s+i\s+can"
    r"|my\s+main\s+function\s+is\s+to"
    r"|my\s+capabilities\s+are\s+currently\s+limited"
    r"|apologies,?\s+but"
    r")",
    re.IGNORECASE,
)


def diversify(text: str, *, idx: int, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    if not TRIGGER_RE.search(text):
        return text
    new_text = text
    fired = False
    for i, pat in enumerate(REFUSAL_PATTERNS):
        new_text, n = pat.subn("", new_text, count=1)
        if n:
            fired = True
            stats[f"pattern{i+1}"] = stats.get(f"pattern{i+1}", 0) + 1
    if not fired:
        return text
    rest = new_text.strip()
    para = stable_choice(f"refusal:{idx}", PARAPHRASES)
    if rest:
        # If anything substantive follows (suggestion of alternatives, etc.),
        # keep it after the paraphrase.
        result = f"{para} {rest}"
    else:
        result = para
    stats["records_diversified"] = stats.get("records_diversified", 0) + 1
    return result


TEXT_QUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TEXT_UNQUOTED_RE = re.compile(
    r'(^|\n)(\s*text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def transform_text_in_payload(payload: str, idx: int, stats: dict) -> str:
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

    new_payload = TEXT_QUOTED_RE.sub(_quoted, payload)
    new_payload = TEXT_UNQUOTED_RE.sub(_unquoted, new_payload)
    return new_payload


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = transform_text_in_payload(er, idx, stats)
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
