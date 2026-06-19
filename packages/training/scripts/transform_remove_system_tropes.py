#!/usr/bin/env python3
"""Remove common AI-slop tropes from system messages and assistant content.

SYSTEM message rewrites:
  - "You are an expert [in/at] X"  → remove the expert claim, keep the rest
  - "You are a helpful AI assistant"  → "You are Eliza, an AI assistant."
  - "You are a function calling AI model" → "You are Eliza, an AI assistant with tool use capabilities."
  - "You are a large language model"  → "You are Eliza, an AI assistant."
  - "You are ChatGPT" / "You are GPT-4" → "You are Eliza, an AI assistant."
  - System messages > 2000 chars: truncate to first 2000 chars at sentence boundary

ASSISTANT content strips:
  - Leading "Certainly! ", "Of course! ", "Sure! ", "Absolutely! ", "Great! " (case insensitive)
  - Leading "As an AI language model, " and variants
  - Trailing " Let me know if you need anything else!" and variants

Usage:
    python transform_remove_system_tropes.py input.jsonl output.jsonl
    cat input.jsonl | python transform_remove_system_tropes.py - -
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


# ──────────────────────────────────────────────────────────────
# System message rewrite patterns
# (applied in order, short-circuit after first full-sentence match)
# ──────────────────────────────────────────────────────────────

# Ordered: most specific first so we don't catch substrings of more specific matches.
_SYSTEM_FULL_REPLACEMENTS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bYou are a function calling AI model\b[^.!?]*[.!?]?",
                re.IGNORECASE),
     "You are Eliza, an AI assistant with tool use capabilities."),
    (re.compile(r"\bYou are a large language model\b[^.!?]*[.!?]?",
                re.IGNORECASE),
     "You are Eliza, an AI assistant."),
    (re.compile(r"\bYou are a helpful AI assistant\b[^.!?]*[.!?]?",
                re.IGNORECASE),
     "You are Eliza, an AI assistant."),
    (re.compile(r"\bYou are ChatGPT\b[^.!?]*[.!?]?",
                re.IGNORECASE),
     "You are Eliza, an AI assistant."),
    (re.compile(r"\bYou are GPT-?4\b[^.!?]*[.!?]?",
                re.IGNORECASE),
     "You are Eliza, an AI assistant."),
]

# "You are an expert [in/at/on] X" — remove the whole sentence fragment.
_EXPERT_RE = re.compile(
    r"You\s+are\s+an?\s+expert(?:\s+(?:in|at|on|with)\s+[^.!?\n]*)?[.!?]?\s*",
    re.IGNORECASE,
)

# System message length cap
_SYSTEM_MAX_CHARS = 2000
_SENTENCE_END_RE = re.compile(r"[.!?]\s+")


# ──────────────────────────────────────────────────────────────
# Assistant content strip patterns
# ──────────────────────────────────────────────────────────────

_LEAD_INTERJECTION_RE = re.compile(
    r"^\s*(?:certainly!?\s*|of\s+course!?\s*|sure!?\s*|absolutely!?\s*|great!?\s*)+",
    re.IGNORECASE,
)

_LEAD_AS_AN_AI_RE = re.compile(
    r"^\s*As\s+an\s+AI(?:\s+language\s+model)?(?:\s+created\s+by\s+\w+)?,?\s*",
    re.IGNORECASE,
)

_TRAIL_LET_ME_KNOW_RE = re.compile(
    r"\s*(?:Let me know if (?:you (?:have|need)|there's) (?:anything|more|other)[^.!?]*[.!?]?"
    r"|Is there anything else I can (?:help|assist)[^.!?]*[.!?]?"
    r"|Feel free to ask[^.!?]*[.!?]?"
    r"|(?:Please |Don't hesitate to )?let me know if you need anything else[.!?]?)"
    r"\s*$",
    re.IGNORECASE,
)


# ──────────────────────────────────────────────────────────────
# Transform functions
# ──────────────────────────────────────────────────────────────

def _truncate_at_sentence(text: str, max_chars: int) -> str:
    """Truncate text to at most max_chars, ending at a sentence boundary."""
    if len(text) <= max_chars:
        return text
    # Find the last sentence-ending punctuation before the limit.
    candidate = text[:max_chars]
    matches = list(_SENTENCE_END_RE.finditer(candidate))
    if matches:
        last_end = matches[-1].end()
        return candidate[:last_end].rstrip()
    # No sentence boundary found; hard-cut.
    return candidate.rstrip()


def clean_system_message(text: str) -> tuple[str, list[str]]:
    if not isinstance(text, str) or not text:
        return text, []
    fired: list[str] = []
    original = text

    # Full-sentence substitutions.
    for pattern, replacement in _SYSTEM_FULL_REPLACEMENTS:
        new_text, n = pattern.subn(replacement, text, count=1)
        if n:
            text = new_text
            fired.append(f"system_rewrite:{pattern.pattern[:40]}")

    # Expert claim removal.
    new_text, n = _EXPERT_RE.subn("", text, count=1)
    if n:
        text = new_text.strip()
        fired.append("system_remove_expert")

    # Length cap.
    if len(text) > _SYSTEM_MAX_CHARS:
        text = _truncate_at_sentence(text, _SYSTEM_MAX_CHARS)
        fired.append("system_truncate")

    text = text.strip()
    if not text:
        return original, []  # do not empty the system message
    return text, fired


def clean_assistant_content(text: str) -> tuple[str, list[str]]:
    if not isinstance(text, str) or not text:
        return text, []
    fired: list[str] = []
    original = text

    # Strip leading interjections.
    new_text, n = _LEAD_INTERJECTION_RE.subn("", text, count=1)
    if n:
        text = new_text.strip()
        if text and text[0].islower():
            text = text[0].upper() + text[1:]
        fired.append("strip_lead_interjection")

    # Strip leading "As an AI...".
    new_text, n = _LEAD_AS_AN_AI_RE.subn("", text, count=1)
    if n:
        text = new_text.strip()
        if text and text[0].islower():
            text = text[0].upper() + text[1:]
        fired.append("strip_lead_as_an_ai")

    # Strip trailing offers.
    new_text, n = _TRAIL_LET_ME_KNOW_RE.subn("", text, count=1)
    if n:
        text = new_text.strip()
        fired.append("strip_trail_offer")

    if not text:
        return original, []  # do not empty assistant content
    return text, fired


def transform_record(rec: dict, stats: dict) -> tuple[dict | None, bool]:
    """Transform a single record. Returns (rec_or_None, was_modified).

    Returns None if the transform would produce an empty record.
    """
    modified = False

    # 1. System prompt in metadata.
    md = rec.get("metadata")
    if isinstance(md, dict):
        sys_p = md.get("system_prompt")
        if isinstance(sys_p, str) and sys_p:
            new_sys, fired = clean_system_message(sys_p)
            if fired:
                if not new_sys:
                    stats["dropped"] = stats.get("dropped", 0) + 1
                    return None, False
                md["system_prompt"] = new_sys
                for f in fired:
                    stats[f] = stats.get(f, 0) + 1
                modified = True

    # 2. Assistant turns in memoryEntries.
    for entry in (rec.get("memoryEntries") or []):
        if not isinstance(entry, dict):
            continue
        role = str(entry.get("role") or "").lower()
        if role not in ("assistant", "agent", "eliza"):
            continue
        content = entry.get("content")
        if not isinstance(content, str) or not content:
            continue
        new_content, fired = clean_assistant_content(content)
        if fired:
            if not new_content:
                stats["dropped"] = stats.get("dropped", 0) + 1
                return None, False
            entry["content"] = new_content
            for f in fired:
                stats[f] = stats.get(f, 0) + 1
            modified = True

    return rec, modified


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────

def _open_input(path_str: str):
    if path_str == "-":
        return sys.stdin
    p = Path(path_str)
    if not p.exists():
        print(f"error: input file not found: {p}", file=sys.stderr)
        sys.exit(2)
    return p.open(encoding="utf-8", errors="replace")


def _open_output(path_str: str):
    if path_str == "-":
        return sys.stdout
    p = Path(path_str)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p.open("w", encoding="utf-8")


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("input", nargs="?", default="-",
                    help="input JSONL file (default: stdin)")
    ap.add_argument("output", nargs="?", default="-",
                    help="output JSONL file (default: stdout)")
    args = ap.parse_args()

    stats: dict = {"processed": 0, "modified": 0, "dropped": 0, "decode_errors": 0}

    fin = _open_input(args.input)
    fout = _open_output(args.output)
    close_in = fin is not sys.stdin
    close_out = fout is not sys.stdout

    try:
        for line in fin:
            line = line.rstrip("\n")
            if not line:
                continue
            stats["processed"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line + "\n")
                continue

            result, modified = transform_record(rec, stats)
            if result is None:
                # dropped — already counted in stats
                continue
            if modified:
                stats["modified"] += 1
            fout.write(json.dumps(result, ensure_ascii=False) + "\n")
    finally:
        if close_in:
            fin.close()
        if close_out:
            fout.close()

    print(
        f"processed={stats['processed']}  "
        f"modified={stats['modified']}  "
        f"dropped={stats['dropped']}  "
        f"decode_errors={stats['decode_errors']}",
        file=sys.stderr,
    )
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
