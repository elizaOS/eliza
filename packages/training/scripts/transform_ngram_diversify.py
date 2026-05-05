#!/usr/bin/env python3
"""N-gram diversification — replace overrepresented phrases with paraphrases.

Targets the 18 candidate phrases identified by analyze_ngrams.py:
- "then confirm to deploy" (45,316 occurrences across 16 n8n-family sources)
- "connect any required credentials" (45,316 — same template tail)
- "call the tool to satisfy the request" (24,376)
- "create an n8n workflow to ..." (25,657)
- "the user s request" (22,357 — possessive-stripped artifact)

Strategy: stratified rewrite of ~60% of occurrences across the synth-template
phrases. The other 40% stay so we don't completely erase the template — we
just break the n-gram concentration.

Per-record decision is keyed by hash(record_idx + phrase) % 100 < 60, so
results are deterministic and the same phrase isn't double-rewritten.

Reads `data/final/train_caveman.jsonl` (or train_deslopped.jsonl if caveman
not yet run). Writes `data/final/train_diversified.jsonl`.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "data" / "final" / "train_diversified.jsonl"
MANIFEST = ROOT / "data" / "final" / "manifest_diversified.json"
SRC_CANDIDATES = [
    ROOT / "data" / "final" / "train_caveman.jsonl",
    ROOT / "data" / "final" / "train_deslopped.jsonl",
    ROOT / "data" / "final" / "train_cleaned.jsonl",
]


def pick_src() -> Path:
    for p in SRC_CANDIDATES:
        if p.exists():
            return p
    raise SystemExit(f"none of these exist: {SRC_CANDIDATES}")


# Paraphrase dictionary. Each key is a regex pattern; value is a list of
# candidate replacements. We pick by deterministic hash to keep output stable.
PARAPHRASES: dict[str, list[str]] = {
    # n8n template tail variants — the most concentrated phrases
    r"\bthen confirm to deploy\b": [
        "then deploy when ready",
        "and deploy when ready",
        "then run it",
        "and confirm to launch",
        "before deploying",
    ],
    r"\bconnect any required credentials\b": [
        "connect the credentials",
        "wire up credentials",
        "set up the credential bindings",
        "add credentials where needed",
        "configure credentials",
    ],
    # "nodes connect any required credentials then confirm to deploy"
    r"\bnodes\b": [
        "nodes",  # leave most
        "the nodes",
        "each node",
    ],
    # assistant_thought tics
    r"\bcall the tool to satisfy the request\b": [
        "invoke the tool to handle the ask",
        "use the tool for this",
        "run the tool to address it",
        "fire the tool to fulfill the user's ask",
    ],
    r"\bcall the tool to\b": [
        "invoke the tool to",
        "fire the tool to",
        "use the tool to",
        "run the tool to",
    ],
    r"\bto satisfy the request\b": [
        "to fulfill the request",
        "to handle this",
        "to address the ask",
        "to answer the user",
    ],
    r"\bthe user s request\b": [
        "the user's request",
        "the user's ask",
        "what the user asked",
        "the request",
    ],
    # n8n-family user-input concentration (do NOT rewrite — these are user msgs)
    # leave "create an n8n workflow" alone (would make user msgs unrealistic)
}

# Stream-scope: which fields each pattern is allowed to rewrite.
ASSISTANT_TEXT_PATTERNS = {
    r"\bthen confirm to deploy\b",
    r"\bconnect any required credentials\b",
}
ASSISTANT_THOUGHT_PATTERNS = {
    r"\bcall the tool to satisfy the request\b",
    r"\bcall the tool to\b",
    r"\bto satisfy the request\b",
    r"\bthe user s request\b",
}

REWRITE_PROBABILITY = 0.60


def stable_choice(seed_key: str, choices: list[str]) -> str:
    h = int(hashlib.md5(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    return choices[h % len(choices)]


def diversify_text(text: str, patterns: set[str], idx: int, stats: dict) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    for pat in patterns:
        compiled = re.compile(pat, re.IGNORECASE)
        replacements = PARAPHRASES.get(pat, [])
        if not replacements:
            continue

        def _replace(match: re.Match) -> str:
            seed = f"{idx}:{pat}:{match.start()}"
            roll = int(hashlib.md5(seed.encode()).hexdigest()[:8], 16) % 100
            if roll >= REWRITE_PROBABILITY * 100:
                return match.group(0)
            choice = stable_choice(seed, replacements)
            stats[f"rewrite.{pat}"] = stats.get(f"rewrite.{pat}", 0) + 1
            return choice

        text = compiled.sub(_replace, text)
    return text


# TOON `text:`/`thought:` extractors — same shape as deslop
TOON_TEXT_RE = re.compile(
    r'(^|\n)(text:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TOON_THOUGHT_RE = re.compile(
    r'(^|\n)(thought:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)


def diversify_toon(toon: str, idx: int, stats: dict) -> str:
    def _text(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = diversify_text(inner, ASSISTANT_TEXT_PATTERNS, idx, stats)
        if new_inner != inner:
            stats["text_changed"] = stats.get("text_changed", 0) + 1
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    def _thought(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        new_inner = diversify_text(inner, ASSISTANT_THOUGHT_PATTERNS, idx, stats)
        if new_inner != inner:
            stats["thought_changed"] = stats.get("thought_changed", 0) + 1
        return f"{prefix}{key}{json.dumps(new_inner, ensure_ascii=False)}{suffix}"

    toon = TOON_TEXT_RE.sub(_text, toon)
    toon = TOON_THOUGHT_RE.sub(_thought, toon)
    return toon


def diversify_record(rec: dict, idx: int, stats: dict) -> dict:
    er = rec.get("expectedResponse")
    if isinstance(er, str) and er:
        new_er = diversify_toon(er, idx, stats)
        if new_er != er:
            rec["expectedResponse"] = new_er
            stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    src = pick_src()
    print(f"[diversify] {src} -> {DST}", file=sys.stderr)
    stats = {"total": 0, "decode_errors": 0, "records_changed": 0,
             "text_changed": 0, "thought_changed": 0}
    with src.open() as fin, DST.open("w") as fout:
        for idx, line in enumerate(fin):
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = diversify_record(rec, idx, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 100000 == 0:
                print(
                    f"[diversify] {stats['total']:>7d}  "
                    f"records_changed={stats['records_changed']:>6d}",
                    file=sys.stderr,
                )
    MANIFEST.write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
