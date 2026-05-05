#!/usr/bin/env python3
"""Deslop assistant text — shorten verbose assistant replies and memoryEntries.

Rules (applied in order, only to assistant `reply` text and memoryEntries):
1. Drop "You are a/an ..." leading sentence when response has >=2 sentences.
2. Drop trailing "Hope this helps", "Let me know if", "Feel free to ...",
   "Anything else?" sentences when >=2 sentences.
3. Drop trailing question when response has >=2 sentences and last sentence
   ends with `?`.
4. Strip leading interjections "Sure thing!", "Of course!", "Absolutely!",
   "I'd be happy to ...".
5. Cap at 1200 chars (replies) / 800 chars (memoryEntries) at last sentence
   boundary that fits.

Operates on TOON-encoded `expectedResponse` for task_type `reply` only.
Also strips memoryEntries[*].content on every record (assistant turns).

Streams. Reads `data/final/train_cleaned.jsonl`, writes
`data/final/train_deslopped.jsonl` and `manifest_deslopped.json`.

Conservative: TOON shape is preserved by string-substituting the inner text
field. We do NOT round-trip through bun encoder — that's 1.5M extra forks.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_cleaned.jsonl"
DST = ROOT / "data" / "final" / "train_deslopped.jsonl"
MANIFEST = ROOT / "data" / "final" / "manifest_deslopped.json"

LEAD_YOU_ARE_RE = re.compile(
    r"^\s*you\s+are\s+(?:a|an|the)\s+[^.!?]*[.!?]\s+",
    re.IGNORECASE,
)
LEAD_INTERJECT_RE = re.compile(
    r"^\s*(?:sure\s+thing!?\s*|of\s+course!?\s*|absolutely!?\s*|certainly!?\s*"
    r"|happy\s+to\s+help!?\s*|i'?d\s+be\s+(?:happy|glad)\s+to\s+[^.!?]*[.!?]\s*"
    r"|great\s+question!?\s*)+",
    re.IGNORECASE,
)
TAIL_HOPE_RE = re.compile(
    r"(?:^|\s)(?:"
    r"hope\s+(?:this|that)\s+(?:helps|works)[^.!?]*[.!?]?"
    r"|let\s+me\s+know\s+if[^.!?]*[.!?]?"
    r"|feel\s+free\s+to[^.!?]*[.!?]?"
    r"|anything\s+else\??[^.!?]*[.!?]?"
    r"|happy\s+to\s+(?:help|assist)[^.!?]*[.!?]?"
    r"|let\s+me\s+know\s+how[^.!?]*[.!?]?"
    r")\s*$",
    re.IGNORECASE,
)

SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'\(])")


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    parts = SENTENCE_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def deslop_text(text: str, *, cap: int) -> tuple[str, list[str]]:
    """Apply deslop rules. Returns (new_text, list_of_rules_fired)."""
    if not isinstance(text, str) or not text.strip():
        return text, []
    fired: list[str] = []
    original = text
    sents = split_sentences(text)
    if len(sents) >= 2:
        # rule 1: lead "You are a/an"
        if re.match(r"^\s*you\s+are\s+(?:a|an|the)\s", sents[0], re.IGNORECASE):
            sents = sents[1:]
            fired.append("lead_you_are")
        # rule 2: tail hope/letmeknow
        if sents and TAIL_HOPE_RE.search(sents[-1]):
            sents = sents[:-1]
            fired.append("tail_hope")
        # rule 3: trailing question
        if len(sents) >= 2 and sents[-1].rstrip().endswith("?"):
            sents = sents[:-1]
            fired.append("tail_question")
    text = " ".join(sents).strip()
    # rule 4: leading interjection
    new_text, n_int = LEAD_INTERJECT_RE.subn("", text, count=1)
    if n_int:
        fired.append("lead_interjection")
        text = new_text.strip()
        # capitalize the new lead
        if text and text[0].islower():
            text = text[0].upper() + text[1:]
    # rule 5: cap at sentence boundary
    if len(text) > cap:
        truncated = []
        running = 0
        for s in split_sentences(text):
            if running + len(s) + 1 > cap:
                break
            truncated.append(s)
            running += len(s) + 1
        if truncated:
            text = " ".join(truncated)
            fired.append("cap_truncate")
    if not text:
        return original, []  # too aggressive, revert
    return text, fired


# TOON `text: "..."` extraction — captures the value across multi-line strings.
# In our corpus, multi-line text uses a `text:` line followed by indented
# content, OR `text: "<single-line>"`. We handle both.
TOON_TEXT_LINE_RE = re.compile(
    r'(^|\n)(text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)


def deslop_toon_reply(toon: str, stats: dict) -> str:
    """Replace `text: "<value>"` content in TOON reply with deslopped version."""
    def _replace(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner, fired = deslop_text(inner, cap=1200)
        if fired:
            for f in fired:
                stats[f"reply.{f}"] = stats.get(f"reply.{f}", 0) + 1
            stats["reply.changed"] = stats.get("reply.changed", 0) + 1
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"
    return TOON_TEXT_LINE_RE.sub(_replace, toon)


def deslop_record(rec: dict, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type") or rec.get("task_type", "")
    # 1. Deslop expectedResponse for reply task_type
    if tt == "reply":
        er = rec.get("expectedResponse")
        if isinstance(er, str) and er:
            new_er = deslop_toon_reply(er, stats)
            if new_er != er:
                rec["expectedResponse"] = new_er

    # 2. Deslop memoryEntries[*].content for assistant turns
    mems = rec.get("memoryEntries")
    if isinstance(mems, list):
        for m in mems:
            if not isinstance(m, dict):
                continue
            role = (m.get("role") or "").lower()
            if role not in ("assistant", "agent", "milady"):
                continue
            c = m.get("content")
            if not isinstance(c, str) or not c:
                continue
            new_c, fired = deslop_text(c, cap=800)
            if fired:
                m["content"] = new_c
                for f in fired:
                    stats[f"mem.{f}"] = stats.get(f"mem.{f}", 0) + 1
                stats["mem.changed"] = stats.get("mem.changed", 0) + 1

    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    stats: dict = {"total": 0, "decode_errors": 0}
    print(f"[deslop] {SRC} -> {DST}", file=sys.stderr)
    with SRC.open() as fin, DST.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = deslop_record(rec, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 100000 == 0:
                print(
                    f"[deslop] {stats['total']:>7d}  "
                    f"reply.changed={stats.get('reply.changed', 0):>6d}  "
                    f"mem.changed={stats.get('mem.changed', 0):>6d}",
                    file=sys.stderr,
                )
    MANIFEST.write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
