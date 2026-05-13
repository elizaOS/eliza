#!/usr/bin/env python3
"""Casual-reply diversification + tighter length cap.

For reply task_types where the user message is a short greeting / thanks /
acknowledgement / personality question:
  1. Diversify "You're welcome!" openings (3,630 records — way too templated)
     with paraphrase variants chosen by deterministic hash.
  2. Strip trailing "If you have any other questions..." / "Let me know if..."
     follow-up offers (40+ ending bigrams "me know", "to help", etc.).
  3. Cap casual replies at 250 chars (vs 1200 deslop cap), at sentence boundary.
  4. Drop "I'm sorry, but" / "I'd be happy to" / "Of course!" leading hedges.

Operates in-place on data/final/train_final.jsonl via temp-file swap.
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

CASUAL_USER_MSG_RE = re.compile(
    # Match if any of these phrases appears as a prefix or near-prefix.
    # No anchoring — "Thanks for the information!" matches because it starts
    # with "thanks". Length cap is enforced separately.
    r"^\s*(hi|hey|hello|yo|sup|hola|good\s+(morning|afternoon|evening|night)|"
    r"thanks|thank\s+you|thx|ty|"
    r"cool|nice|sweet|awesome|great|ok|okay|alright|sure|yep|yeah|nah|nope|"
    r"right|exactly|true|"
    r"how\s+(are\s+you|is\s+it\s+going|s\s+it\s+going|are\s+things)|"
    r"what.?s\s+(up|good|new)|"
    r"lol|haha|hehe|hmm|got\s+it|gotcha|i\s+see|"
    r"tell\s+me\s+a\s+(joke|story|fact|secret)|"
    r"who\s+are\s+you|what\s+are\s+you|what.?s\s+your\s+name|"
    r"(do|can)\s+you\s+(know|like|think|feel|enjoy)|"
    r"are\s+you\s+(a|an|good|bad|sentient|conscious))\b",
    re.IGNORECASE,
)

# Paraphrases for "You're welcome!" — keeps intent, varies surface form.
# The first entry is the original, kept at low frequency so the natural
# phrase is still represented but doesn't dominate.
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
    "You're welcome!",  # natural, kept at 1/18 weight
]

LEAD_WELCOME_RE = re.compile(r"^\s*(you'?re\s+(very\s+|so\s+)?welcome[!.,]?\s*)", re.IGNORECASE)
LEAD_HEDGE_RE = re.compile(
    r"^\s*(?:"
    r"i'?d\s+be\s+(?:happy|glad|pleased)\s+to\s+[^.!?]*[.!?]\s*"
    r"|of\s+course[!.,]?\s*"
    r"|sure\s+thing[!.,]?\s*"
    r"|absolutely[!.,]?\s*"
    r"|certainly[!.,]?\s*"
    r"|i'?m\s+sorry[,.]?\s*but\s+"
    r"|happy\s+to\s+help[!.,]?\s*"
    r"|that'?s\s+a\s+great\s+question[!.,]?\s*"
    r")",
    re.IGNORECASE,
)

TAIL_FOLLOWUP_RE = re.compile(
    # Match a complete trailing follow-up clause and strip it. The clause may
    # be a separate sentence (preceded by .?!) or a comma continuation.
    r"(?:[.,;]\s+|\s+)?(?:"
    # "If you (have/need/want) ... [questions/help/info/anything else]" —
    # whole if-clause through end-of-string
    r"if\s+you\s+(?:have|need|want|ever\s+(?:need|want|have))[^.!?]*[.!?]?"
    # "If you'd like ..."
    r"|if\s+you'?d\s+like[^.!?]*[.!?]?"
    # "Let me know if/when/how ..."
    r"|let\s+me\s+know(?:\s+if|\s+when|\s+how|[!.,]?\s*$)[^.!?]*[.!?]?"
    # "Feel free to ..."
    r"|feel\s+free\s+to\s+[^.!?]*[.!?]?"
    # "Just (ask|let me know)"
    r"|just\s+(?:ask|let\s+me\s+know|reach\s+out)[^.!?]*[.!?]?"
    # "Happy to help/assist further/chat ..."
    r"|happy\s+to\s+(?:help|assist|chat)\s+(?:with|further|more|again)[^.!?]*[.!?]?"
    # "Hope this/that helps ..."
    r"|hope\s+(?:this|that)\s+helps?[^.!?]*[.!?]?"
    # Standalone closers
    r"|safe\s+travels?[!.,]?"
    r"|have\s+a\s+(?:great|good|nice|wonderful)\s+(?:day|one|evening|weekend)[!.,]?"
    r"|stay\s+safe[!.,]?"
    r"|take\s+care[!.,]?"
    r"|reach\s+out\s+anytime[!.,]?"
    r"|anything\s+else[?!.]?"
    r")\s*$",
    re.IGNORECASE,
)

CASUAL_CAP_CHARS = 250
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'\(])")


def stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    parts = SENTENCE_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def shorten_casual(text: str, *, idx: int, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    fired: list[str] = []
    original = text

    # 1. diversify "You're welcome!" lead
    welcome_fired = False
    m = LEAD_WELCOME_RE.match(text)
    if m:
        replacement = stable_choice(f"welcome:{idx}", WELCOME_PARAPHRASES)
        rest = text[m.end():].lstrip()
        text = replacement + (" " + rest if rest else "")
        fired.append("welcome_paraphrase")
        welcome_fired = True

    # 2. strip trailing follow-up offers FIRST (so lead_hedge doesn't end up
    #    eating the only meaningful content after it)
    new_text, n_f = TAIL_FOLLOWUP_RE.subn("", text)
    if n_f:
        text = new_text.rstrip().rstrip(",;").rstrip()
        # restore terminal punctuation if we stripped it
        if text and text[-1] not in ".!?":
            text += "."
        fired.append("tail_followup")

    # 3. strip leading hedges — but skip if we just inserted a welcome
    #    paraphrase (some paraphrases like "Sure thing!" would self-cancel).
    if not welcome_fired:
        new_text, n_h = LEAD_HEDGE_RE.subn("", text, count=1)
        if n_h:
            if new_text and new_text[0].islower():
                new_text = new_text[0].upper() + new_text[1:]
            text = new_text
            fired.append("lead_hedge")

    # 4. cap at 250 chars (sentence boundary)
    if len(text) > CASUAL_CAP_CHARS:
        truncated = []
        running = 0
        for s in split_sentences(text):
            if running + len(s) + 1 > CASUAL_CAP_CHARS:
                break
            truncated.append(s)
            running += len(s) + 1
        if truncated:
            text = " ".join(truncated)
            fired.append("cap250")
        # if still over (e.g. one sentence is >250 chars), hard truncate
        if len(text) > CASUAL_CAP_CHARS:
            text = text[:CASUAL_CAP_CHARS].rsplit(" ", 1)[0] + "..."
            fired.append("hard_truncate")

    if not text:
        return original
    for f in fired:
        stats[f"casual.{f}"] = stats.get(f"casual.{f}", 0) + 1
    if fired:
        stats["casual.changed"] = stats.get("casual.changed", 0) + 1
    return text


def is_casual(rec: dict) -> bool:
    cm_obj = rec.get("currentMessage")
    if not isinstance(cm_obj, dict):
        return False
    cm = cm_obj.get("content", "") or ""
    if len(cm.strip()) > 60:
        return False
    if re.search(
        r"(summarize|summary|recap|wrap.?up|breakdown|list|fetch|"
        r"get\s+me|find|search|pull|show\s+me|"
        r"what\s+(does|did|is\s+the|are\s+the))",
        cm, re.IGNORECASE
    ):
        return False
    return bool(CASUAL_USER_MSG_RE.match(cm.strip())) or len(cm.strip()) < 25


NATIVE_JSON_TEXT_RE = re.compile(
    r'(^|\n)(text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply" or not is_casual(rec):
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
        new_inner = shorten_casual(inner, idx=idx, stats=stats)
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    new_er = NATIVE_JSON_TEXT_RE.sub(_replace, er)
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
