#!/usr/bin/env python3
"""Task-reply deslop — strip templated openers and trailing slop on
non-casual reply text.

Targets identified by post-cleanup n-gram analysis:
  - "Hello! I'd be happy to help you with X." (4,914 records, nemotron-rl-tool-use)
  - "Sure, here is/are " (944+ records, bitagent-tool-calling)
  - "Apologies, but " (2,071 records, hermes-reasoning-tool-use)
  - "Let me know if you need..." trailing offers (1,546 records)
  - "I'd be happy to help" / "Happy to help with" hedges
  - Trailing "Hope this helps" / "Have a great day"

Operates in-place on data/final/train_final.jsonl.
Skips records flagged as casual (those go through transform_casual_reply_shorten).
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

# --- Lead patterns (ordered: longer/more-specific first) ---
LEAD_PATTERNS = [
    # "Hello! I'd be happy to help you with X."  → strip whole sentence
    (re.compile(
        r"^\s*hello!?\s+i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help\s+(?:you\s+)?(?:with\s+[^.!?]+)?[.!?]\s*",
        re.IGNORECASE,
    ), ""),
    # "Hi! I'd be happy to..." variant
    (re.compile(
        r"^\s*hi!?\s+i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help[^.!?]*[.!?]\s*",
        re.IGNORECASE,
    ), ""),
    # "I'd be happy to help with X." (no greeting)
    (re.compile(
        r"^\s*i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+help\s+(?:you\s+)?(?:with\s+[^.!?]+)?[.!?]\s*",
        re.IGNORECASE,
    ), ""),
    # "Sure, here is/are " → "Here is/are " (preserves the substantive part)
    (re.compile(r"^\s*sure[!,.]?\s+here\s+(is|are)\s+", re.IGNORECASE),
     r"Here \1 "),
    # "Sure, " standalone → "" (when followed by capital word — substantive)
    (re.compile(r"^\s*sure[!,.]\s+(?=[A-Z])", re.IGNORECASE), ""),
    # "Of course! " standalone
    (re.compile(r"^\s*of\s+course[!,.]\s+(?=[A-Z])", re.IGNORECASE), ""),
    # "Absolutely! " / "Certainly! "
    (re.compile(r"^\s*(?:absolutely|certainly)[!,.]\s+(?=[A-Z])", re.IGNORECASE), ""),
    # "Apologies, but " → ""
    (re.compile(r"^\s*apologies[,.]\s*but\s+", re.IGNORECASE), ""),
    # "I'm sorry, but " (LEAVE — common refusal phrasing, strip only when
    # followed by "I" — "I'm sorry, but I can't" → "I can't")
    (re.compile(r"^\s*i'?m\s+sorry[,.]\s*but\s+(?=[Ii])", re.IGNORECASE), ""),
    # "That's a great question!" / "Great question!" — fluff
    (re.compile(r"^\s*(?:that'?s\s+a\s+)?great\s+question[!.,]\s*", re.IGNORECASE), ""),
    # "Thank you for asking" — fluff
    (re.compile(r"^\s*thank\s+you\s+for\s+asking[!.,]\s*", re.IGNORECASE), ""),
]

# --- Tail patterns ---
TAIL_PATTERNS = [
    # "Let me know if you need anything else / further help / more info."
    re.compile(
        r"\s*(?:[.!?]\s+)?let\s+me\s+know\s+(?:if|when|how)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    # "If you (have|need) any other questions/help/info..."
    re.compile(
        r"\s*(?:[.!?]\s+)?if\s+you\s+(?:have|need|want)\s+(?:any\s+)?(?:other|more|further|additional)\s*(?:questions?|help|info(?:rmation)?|assistance|details?)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    # "Feel free to ask/reach out."
    re.compile(
        r"\s*(?:[.!?]\s+)?feel\s+free\s+to\s+(?:ask|reach\s+out|message|contact)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    # "Happy to help further/more/again with..."
    re.compile(
        r"\s*(?:[.!?]\s+)?happy\s+to\s+(?:help|assist|chat)\s+(?:further|more|again|with)[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    # "Hope this/that helps"
    re.compile(
        r"\s*(?:[.!?]\s+)?hope\s+(?:this|that)\s+helps?[^.!?]*[.!?]?\s*$",
        re.IGNORECASE,
    ),
    # "Have a great day/one/evening/weekend"
    re.compile(
        r"\s*(?:[.!?]\s+)?have\s+a\s+(?:great|good|nice|wonderful)\s+(?:day|one|evening|weekend|time)[!.,]?\s*$",
        re.IGNORECASE,
    ),
    # "Take care!"
    re.compile(r"\s*(?:[.!?]\s+)?take\s+care[!.,]?\s*$", re.IGNORECASE),
    # "Anything else?"
    re.compile(r"\s*(?:[.!?]\s+)?anything\s+else[?!.,]?\s*$", re.IGNORECASE),
    # "Reach out anytime!"
    re.compile(r"\s*(?:[.!?]\s+)?reach\s+out\s+anytime[!.,]?\s*$", re.IGNORECASE),
]

CASUAL_USER_MSG_RE = re.compile(
    r"^\s*(hi|hey|hello|yo|sup|hola|good\s+(?:morning|afternoon|evening|night)|"
    r"thanks|thank\s+you|thx|ty|"
    r"cool|nice|sweet|awesome|great|ok|okay|alright|sure|yep|yeah|nah|nope|"
    r"right|exactly|true|lol|haha|hehe)\b",
    re.IGNORECASE,
)

HARD_CAP_CHARS = 4000  # for genuinely long task replies


def is_casual(rec: dict) -> bool:
    cm_obj = rec.get("currentMessage")
    if not isinstance(cm_obj, dict):
        return False
    cm = (cm_obj.get("content", "") or "").strip()
    if len(cm) > 60:
        return False
    if re.search(
        r"(summarize|summary|recap|wrap.?up|breakdown|list|fetch|"
        r"get\s+me|find|search|pull|show\s+me|"
        r"what\s+(?:does|did|is\s+the|are\s+the))",
        cm, re.IGNORECASE,
    ):
        return False
    return bool(CASUAL_USER_MSG_RE.match(cm)) or len(cm) < 25


SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'\(])")


def deslop_task_text(text: str, *, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    original = text
    fired: list[str] = []

    # Lead strips
    for pat, repl in LEAD_PATTERNS:
        new_text, n = pat.subn(repl, text, count=1)
        if n:
            text = new_text
            fired.append(f"lead.{pat.pattern[:30]}")
            break  # one lead strip per record

    # Capitalize new lead if needed
    if text and text[0].islower():
        text = text[0].upper() + text[1:]

    # Tail strips (multiple may fire)
    for pat in TAIL_PATTERNS:
        new_text, n = pat.subn("", text)
        if n:
            text = new_text.rstrip()
            if text and text[-1] not in ".!?":
                text += "."
            fired.append("tail.followup")

    # Hard cap at 4000 chars (sentence boundary)
    if len(text) > HARD_CAP_CHARS:
        sents = SENTENCE_RE.split(text)
        truncated = []
        running = 0
        for s in sents:
            if running + len(s) + 1 > HARD_CAP_CHARS:
                break
            truncated.append(s)
            running += len(s) + 1
        if truncated:
            text = " ".join(truncated)
            fired.append("hard_cap")

    if fired:
        for f in fired:
            stats[f] = stats.get(f, 0) + 1
        stats["any_change"] = stats.get("any_change", 0) + 1
    return text if text else original


TOON_TEXT_RE = re.compile(
    r'(^|\n)(text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)


def transform_record(rec: dict, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply" or is_casual(rec):
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec

    def _replace(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = deslop_task_text(inner, stats=stats)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    new_er = TOON_TEXT_RE.sub(_replace, er)
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
