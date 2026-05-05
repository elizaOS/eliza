#!/usr/bin/env python3
"""Remediate the default-thought leak in an already-packed `train.jsonl`.

Background
----------
The original ingest adapters injected a single literal string as the
"thought" any time the upstream record had no real reasoning trace. The
two worst offenders were:

    "Reply to the user."
    "Call the tool to satisfy the request."

Plus seven trivial placeholders the round-2 / round-3 synth used as
stand-ins. The full set lives in
`scripts/lib/eliza_record.DEFAULT_THOUGHT_LEAKS` — the single source of
truth.

`transform_purge_default_thoughts.py` is a fast first-line-prefix pass
that handles the common case where `expectedResponse` is plain TOON
beginning with `thought: <leak>`. It does NOT decode TOON, so it can't
touch records where the thought is nested inside a structured envelope
(planner / tool envelopes), nor records where the thought sits on its
own escaped line.

This transform is the deep pass: TOON-decode → rewrite the `thought`
field → TOON-encode. Synthesis comes from the user message
(`currentMessage.content`) for reply tasks, and from the tool spec
(`metadata.toolSpecs[0].name`) for tool_call / mcp_tool_call tasks.
Determinism is seeded from `roomName + agentId` (with the user message
appended) so every re-run produces byte-identical output.

Output: `data/intermediate/train_thought_fixed.jsonl` plus a manifest
JSON describing what was rewritten. The script never overwrites the
input — operators stage and diff before swapping into `data/final/`.

Usage
-----
    .venv/bin/python scripts/transform_fix_default_thoughts.py
    .venv/bin/python scripts/transform_fix_default_thoughts.py \
        --input data/final/train.jsonl \
        --output data/intermediate/train_thought_fixed.jsonl
    .venv/bin/python scripts/transform_fix_default_thoughts.py --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.lib.eliza_record import (  # noqa: E402
    DEFAULT_THOUGHT_LEAKS,
    is_default_thought_leak,
)
from scripts.lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("fix-default-thoughts")

# Hard-cap synthesized thought length at 20 words — anything longer would
# defeat the "informative-but-not-load-bearing" purpose. Spec from caller.
_MAX_SYNTH_WORDS = 20

# Task types whose target carries a `thought:` field worth scrubbing.
# Other task types (e.g. embedding_routing, classification) use a different
# template and don't have a thought field.
_TASKS_WITH_THOUGHT: frozenset[str] = frozenset({
    "reply",
    "agent_trace",
    "tool_call",
    "mcp_tool_call",
    "shell_command",
    "casual_reply",
    "n8n_workflow_generation",
})

_REPLY_TASKS: frozenset[str] = frozenset({
    "reply", "casual_reply", "agent_trace",
})

_TOOL_TASKS: frozenset[str] = frozenset({
    "tool_call", "mcp_tool_call",
})

_SHELL_TASKS: frozenset[str] = frozenset({
    "shell_command",
})

# Which words to drop when summarizing a user message into a short thought.
# Common stop-words plus a handful of corpus-specific filler tokens.
_STOPWORDS: frozenset[str] = frozenset({
    "a", "an", "the", "and", "or", "but", "if", "then", "is", "are", "was",
    "were", "be", "been", "being", "i", "you", "he", "she", "it", "we",
    "they", "this", "that", "these", "those", "to", "of", "for", "in",
    "on", "at", "by", "with", "from", "as", "into", "about", "do", "does",
    "did", "have", "has", "had", "can", "could", "will", "would", "should",
    "shall", "may", "might", "must", "your", "my", "our", "their", "his",
    "her", "its", "me", "us", "them", "him",
})

# Tokenizer: word characters plus apostrophes (handles "user's").
_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


# ───────────────────────── synthesis helpers ─────────────────────────


def _summarize_user_msg(msg: str, max_words: int = 8) -> str:
    """Take the first `max_words` content-bearing tokens from `msg`.

    Drops short stop-words so the summary keeps the load-bearing nouns /
    verbs. Returns "" when the message is empty or all stop-words.
    """
    if not msg:
        return ""
    tokens = _WORD_RE.findall(msg)
    keep: list[str] = []
    for tok in tokens:
        low = tok.lower()
        if low in _STOPWORDS:
            continue
        keep.append(tok)
        if len(keep) >= max_words:
            break
    return " ".join(keep).strip()


def _verb_from_tool_name(name: str) -> str:
    """Turn a tool name into a short verb-phrase fragment.

    `web_search` → "search the web", `read_file` → "read file",
    `getWeather` → "get weather". Falls back to the name itself when
    no segmentation works.
    """
    if not name:
        return "complete the request"
    # split snake_case and camelCase
    segments = re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z]|$)", name)
    if not segments:
        return name.replace("_", " ").lower()
    parts = [s.lower() for s in segments if s]
    if len(parts) == 1:
        return parts[0]
    # heuristic: first token is the verb
    verb = parts[0]
    obj = " ".join(parts[1:])
    return f"{verb} {obj}".strip()


def _truncate_words(text: str, max_words: int = _MAX_SYNTH_WORDS) -> str:
    """Cap to `max_words` whitespace-split tokens. Strips trailing punctuation
    on truncation so the result reads cleanly."""
    if not text:
        return ""
    tokens = text.split()
    if len(tokens) <= max_words:
        return text.strip()
    out = " ".join(tokens[:max_words]).rstrip(",;:- ")
    return out


def _seeded_pick(seed: str, options: tuple[str, ...]) -> str:
    """Deterministic pick from `options` keyed by a sha256 of `seed`."""
    if not options:
        return ""
    digest = hashlib.sha256(seed[:512].encode("utf-8", "replace")).digest()
    n = int.from_bytes(digest[:8], "big")
    return options[n % len(options)]


# Short suffix templates per task family. Each phrase is intentionally
# unique so the corpus distribution isn't dominated by one phrasing.
_REPLY_SUFFIXES: tuple[str, ...] = (
    "; reply directly.",
    "; answer plainly.",
    "; respond now.",
    "; write back.",
    "; addressing it.",
    "; engaging the request.",
)

_TOOL_VERBS: tuple[str, ...] = (
    "calling",
    "invoking",
    "dispatching to",
    "routing to",
    "running",
)

_SHELL_SUFFIXES: tuple[str, ...] = (
    "; running the command.",
    "; dispatching the shell call.",
    "; executing in the terminal.",
    "; issuing the shell action.",
)


def synthesize_thought(
    *,
    task_type: str,
    user_msg: str,
    tool_specs: list[dict[str, Any]],
    seed: str,
) -> str:
    """Build an informative, deterministic, ≤20-word replacement thought.

    Always seeded by `seed` so the same record always produces the same
    thought — re-runs are byte-identical. Never returns a leak literal.

    Falls back to the safest summary when context is missing (e.g. tool
    task with no toolSpecs). Returns "" when we have absolutely no
    signal — callers should treat "" as "drop the field rather than
    inject a placeholder" (the runtime tolerates an empty thought).
    """
    if task_type in _TOOL_TASKS:
        tool_name = ""
        for spec in (tool_specs or []):
            if isinstance(spec, dict):
                cand = spec.get("name") or spec.get("tool") or ""
                if cand:
                    tool_name = str(cand)
                    break
        if tool_name:
            verb = _seeded_pick(seed + "|verb", _TOOL_VERBS)
            phrase = _verb_from_tool_name(tool_name)
            # "calling web_search to handle <summary>"
            if user_msg:
                summary = _summarize_user_msg(user_msg, max_words=6)
                if summary:
                    candidate = f"need to {phrase}; {verb} {tool_name}"
                    return _truncate_words(candidate)
            return _truncate_words(f"need to {phrase}; {verb} {tool_name}")
        # No tool spec — fall through to a generic "tool call needed" line
        # but seeded so we still rotate phrasings.
        if user_msg:
            summary = _summarize_user_msg(user_msg, max_words=6)
            if summary:
                return _truncate_words(
                    f"tool needed for {summary}; selecting one")
        return _truncate_words("tool dispatch required; picking the right one")

    if task_type in _SHELL_TASKS:
        if user_msg:
            summary = _summarize_user_msg(user_msg, max_words=6)
            if summary:
                suffix = _seeded_pick(seed + "|shell", _SHELL_SUFFIXES)
                return _truncate_words(
                    f"shell needed for {summary}{suffix}")
        return _truncate_words("shell command needed; running it")

    if task_type in _REPLY_TASKS:
        if user_msg:
            summary = _summarize_user_msg(user_msg, max_words=8)
            if summary:
                suffix = _seeded_pick(seed + "|reply", _REPLY_SUFFIXES)
                return _truncate_words(f"user asks {summary}{suffix}")
        return _truncate_words("user message arrived; replying directly")

    # Unknown task type — refuse to synthesize. Caller treats "" as drop.
    return ""


# ───────────────────────── TOON splice helpers ─────────────────────────


@dataclass
class FixStats:
    total: int = 0
    eligible: int = 0
    no_leak: int = 0
    rewritten: int = 0
    decode_fail: int = 0
    encode_fail: int = 0
    dropped_no_synth: int = 0
    by_task: dict[str, int] = field(default_factory=dict)
    by_phrase: dict[str, int] = field(default_factory=dict)


def extract_thought(toon_text: str) -> tuple[str | None, str | None]:
    """Return (raw_value, key_used). `raw_value` strips quotes; `key_used`
    is the literal prefix matched (`thought:` or `"thought":`) so the
    caller can route between TOON-decode and a quick line-rewrite path.

    Returns (None, None) if no thought field is present.
    """
    if not toon_text:
        return None, None
    for line in toon_text.splitlines():
        s = line.strip()
        for key in ("thought:", '"thought":'):
            if s.startswith(key):
                v = s[len(key):].strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                    v = v[1:-1]
                return v, key
    return None, None


def rewrite_via_toon(
    decoder: ToonDecoder,
    encoder: ToonEncoder,
    toon_text: str,
    new_thought: str,
) -> str | None:
    """Decode → replace `thought` → re-encode. Returns the new TOON or
    None on decode/encode failure (caller falls back to line rewrite)."""
    safe = new_thought.replace("\n", " ").strip()
    try:
        obj = decoder.decode(toon_text)
    except Exception:
        return None
    if isinstance(obj, dict):
        new_obj: dict[str, Any] = {"thought": safe}
        for k, v in obj.items():
            if k == "thought":
                continue
            new_obj[k] = v
    else:
        # Non-dict TOON (rare) — wrap so the thought lives at the top.
        new_obj = {"thought": safe, "value": obj}
    try:
        return encoder.encode(new_obj)
    except Exception:
        return None


_QUOTE_NEEDED_RE = re.compile(r"[:#\\\"']|^\s|\s$")


def rewrite_via_line_splice(toon_text: str, new_thought: str) -> str:
    """Replace just the first `thought:` / `"thought":` line.

    Used as a last-resort when the TOON document doesn't decode cleanly
    (e.g. because a downstream pass corrupted it). Preserves the original
    quoting style of the line.
    """
    safe = new_thought.replace("\n", " ").strip()
    quote = _QUOTE_NEEDED_RE.search(safe) is not None
    rendered = f'"{safe}"' if quote else safe
    out_lines: list[str] = []
    replaced = False
    for line in toon_text.splitlines():
        if not replaced:
            stripped = line.lstrip()
            indent = line[: len(line) - len(stripped)]
            if stripped.startswith("thought:"):
                out_lines.append(f"{indent}thought: {rendered}")
                replaced = True
                continue
            if stripped.startswith('"thought":'):
                out_lines.append(f'{indent}"thought": {rendered}')
                replaced = True
                continue
        out_lines.append(line)
    return "\n".join(out_lines)


# ───────────────────────── main pipeline ─────────────────────────


def process_record(
    rec: dict[str, Any],
    decoder: ToonDecoder,
    encoder: ToonEncoder,
    stats: FixStats,
) -> tuple[dict[str, Any], bool]:
    """Returns (possibly-rewritten record, was_rewritten)."""
    md = rec.get("metadata") or {}
    task_type = md.get("task_type") or ""
    if task_type not in _TASKS_WITH_THOUGHT:
        return rec, False

    er = rec.get("expectedResponse") or ""
    if not er:
        return rec, False

    existing, _key = extract_thought(er)
    if existing is None:
        # No thought line at all — nothing to scrub here. The "fill in
        # missing thought" path is repack_v9.py's job.
        return rec, False

    if not is_default_thought_leak(existing):
        stats.no_leak += 1
        return rec, False

    stats.eligible += 1

    user_msg = ((rec.get("currentMessage") or {}).get("content") or "")
    tool_specs_raw = md.get("toolSpecs") or []
    tool_specs: list[dict[str, Any]] = [
        s for s in tool_specs_raw if isinstance(s, dict)
    ]

    seed = "|".join((
        rec.get("roomName", "") or "",
        rec.get("agentId", "") or "",
        user_msg[:128],
    ))
    new_thought = synthesize_thought(
        task_type=task_type,
        user_msg=user_msg,
        tool_specs=tool_specs,
        seed=seed,
    )
    if not new_thought:
        stats.dropped_no_synth += 1
        return rec, False
    if is_default_thought_leak(new_thought):
        # Belt-and-suspenders: never write a leak literal back. If the
        # synthesizer somehow produced one, fall back to a noop.
        stats.dropped_no_synth += 1
        return rec, False

    rewritten = rewrite_via_toon(decoder, encoder, er, new_thought)
    if rewritten is None:
        stats.decode_fail += 1
        rewritten = rewrite_via_line_splice(er, new_thought)
        if rewritten is None or rewritten == er:
            stats.encode_fail += 1
            return rec, False

    rec["expectedResponse"] = rewritten
    stats.rewritten += 1
    stats.by_task[task_type] = stats.by_task.get(task_type, 0) + 1
    stats.by_phrase[new_thought] = stats.by_phrase.get(new_thought, 0) + 1
    return rec, True


def process_file(
    inp: Path,
    out: Path,
    *,
    dry_run: bool,
    limit: int,
) -> FixStats:
    encoder = ToonEncoder()
    decoder = ToonDecoder()
    stats = FixStats()

    out_handle = None if dry_run else out.open("w", encoding="utf-8")
    try:
        with inp.open("r", encoding="utf-8") as fin:
            for idx, line in enumerate(fin):
                if limit and idx >= limit:
                    break
                line = line.rstrip("\n")
                if not line:
                    continue
                stats.total += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    if out_handle is not None:
                        out_handle.write(line + "\n")
                    continue
                new_rec, _ = process_record(rec, decoder, encoder, stats)
                if out_handle is not None:
                    out_handle.write(
                        json.dumps(new_rec, ensure_ascii=False) + "\n")
                if stats.total % 50000 == 0:
                    log.info(
                        "%d records  eligible=%d rewritten=%d "
                        "decode_fail=%d dropped=%d",
                        stats.total, stats.eligible, stats.rewritten,
                        stats.decode_fail, stats.dropped_no_synth,
                    )
    finally:
        if out_handle is not None:
            out_handle.close()
        encoder.close()
        decoder.close()

    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path,
                    default=ROOT / "data" / "final" / "train.jsonl")
    ap.add_argument("--output", type=Path,
                    default=ROOT / "data" / "intermediate"
                                / "train_thought_fixed.jsonl")
    ap.add_argument("--manifest", type=Path,
                    default=ROOT / "data" / "intermediate"
                                / "train_thought_fixed.manifest.json")
    ap.add_argument("--limit", type=int, default=0,
                    help="0 = no limit; useful for spot-checks")
    ap.add_argument("--dry-run", action="store_true",
                    help="scan and report counts without writing output")
    args = ap.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 1

    if not args.dry_run:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.parent.mkdir(parents=True, exist_ok=True)

    log.info("input=%s output=%s dry_run=%s",
             args.input, args.output, args.dry_run)
    log.info("known leak literals (%d): %s",
             len(DEFAULT_THOUGHT_LEAKS),
             ", ".join(repr(s) for s in DEFAULT_THOUGHT_LEAKS))

    start = time.time()
    stats = process_file(args.input, args.output,
                         dry_run=args.dry_run, limit=args.limit)
    elapsed = time.time() - start

    manifest = {
        "input": str(args.input),
        "output": None if args.dry_run else str(args.output),
        "dry_run": args.dry_run,
        "elapsed_sec": round(elapsed, 1),
        "stats": {
            "total": stats.total,
            "eligible": stats.eligible,
            "no_leak": stats.no_leak,
            "rewritten": stats.rewritten,
            "decode_fail": stats.decode_fail,
            "encode_fail": stats.encode_fail,
            "dropped_no_synth": stats.dropped_no_synth,
            "by_task": stats.by_task,
            "by_phrase_top20": dict(sorted(
                stats.by_phrase.items(), key=lambda kv: -kv[1],
            )[:20]),
        },
        "leak_literals": list(DEFAULT_THOUGHT_LEAKS),
    }
    if not args.dry_run:
        args.manifest.write_text(json.dumps(manifest, indent=2))
    log.info("DONE in %.1fs — %s", elapsed, json.dumps(manifest["stats"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
