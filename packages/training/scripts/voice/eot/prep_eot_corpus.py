#!/usr/bin/env python3
"""Build an EOT training corpus from heterogeneous conversation sources.

Reads conversations from canonical formats (subtitle SRT, JSONL with
`turns: [...]`, scenario YAML, plain dialog), formats them with the
Gemma chat template the eliza-1 chat model uses, and emits
`(transcript_so_far, label_eot)` pairs:

  - positive (label=1): the transcript ends at a complete user turn
    boundary (the natural place an `<end_of_turn>` token would follow).
  - negative (label=0): the transcript is chopped mid-token at a
    random boundary inside a user turn (no `<end_of_turn>` would follow).

Output: Parquet (preferred) or JSONL with columns
  `(text: str, label: int, source: str, conversation_id: str)`.

PRIVACY FILTER CONTRACT (mandatory per packages/training/AGENTS.md §3):
every transcript written to disk runs through the privacy filter at
`packages/training/scripts/validate_corpus.py`. Records that fail the
filter are dropped (logged but not retained). The filter is loaded
once and reused per process — no per-record import cost.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("eot.prep_eot_corpus")

# ---------------------------------------------------------------------------
# Chat template
# ---------------------------------------------------------------------------

GEMMA_USER_START = "<start_of_turn>user\n"
GEMMA_USER_END = "<end_of_turn>"
GEMMA_NL = "\n"


def apply_gemma_user_template(text: str) -> str:
    """Format `text` as the Gemma chat model does.

    The detector reads `P(<end_of_turn>)` from the next-token distribution
    *after* the trailing newline; do NOT append `<end_of_turn>` here.
    """
    return f"{GEMMA_USER_START}{text}{GEMMA_NL}"


# ---------------------------------------------------------------------------
# Record shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EotRecord:
    """One training example. `text` is already chat-template-formatted."""

    text: str
    label: int  # 1 = end of turn, 0 = mid-turn
    source: str
    conversation_id: str

    def __post_init__(self) -> None:
        if self.label not in (0, 1):
            raise ValueError(f"label must be 0 or 1, got {self.label}")
        if not self.text:
            raise ValueError("text must be non-empty")


# ---------------------------------------------------------------------------
# Source readers — pluggable per format
# ---------------------------------------------------------------------------


def read_jsonl_turns(path: Path) -> Iterator[tuple[str, list[str]]]:
    """Yield (conversation_id, user_turns) from JSONL `{turns: [...]}`.

    Each JSONL line is one conversation. Turns is a list of strings or
    objects with `{role, content}`; we keep the user-side turns in
    speaking order.
    """
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "skipping malformed line in %s:%d (%s)",
                    path,
                    line_no,
                    exc,
                )
                continue
            convo_id = str(obj.get("id") or obj.get("conversation_id") or f"{path.stem}:{line_no}")
            raw_turns = obj.get("turns") or obj.get("messages") or []
            user_turns: list[str] = []
            for turn in raw_turns:
                if isinstance(turn, str):
                    user_turns.append(turn)
                elif isinstance(turn, dict):
                    role = (turn.get("role") or "").lower()
                    content = turn.get("content") or turn.get("text") or ""
                    if role == "user" and content:
                        user_turns.append(str(content))
            if user_turns:
                yield convo_id, user_turns


def read_srt(path: Path) -> Iterator[tuple[str, list[str]]]:
    """Yield (conversation_id, lines) from an .srt subtitle file.

    Each non-empty subtitle line is treated as one complete utterance
    (positive EOT example). One file = one conversation.
    """
    lines: list[str] = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        block: list[str] = []
        for raw in handle:
            stripped = raw.strip()
            if not stripped:
                if block:
                    # Drop the numeric index + timecode lines; keep dialog
                    dialog = [
                        chunk
                        for chunk in block
                        if not chunk.isdigit() and "-->" not in chunk
                    ]
                    if dialog:
                        lines.append(" ".join(dialog))
                    block = []
                continue
            block.append(stripped)
        if block:
            dialog = [
                chunk for chunk in block if not chunk.isdigit() and "-->" not in chunk
            ]
            if dialog:
                lines.append(" ".join(dialog))
    if lines:
        yield path.stem, lines


def read_plain_dialog(path: Path) -> Iterator[tuple[str, list[str]]]:
    """Yield (conversation_id, lines) from a plain text dialog file.

    One line per turn. Blank lines separate conversations.
    """
    convo_idx = 0
    current: list[str] = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                if current:
                    yield f"{path.stem}:{convo_idx}", current
                    convo_idx += 1
                    current = []
                continue
            current.append(line)
    if current:
        yield f"{path.stem}:{convo_idx}", current


# ---------------------------------------------------------------------------
# Negative synthesis
# ---------------------------------------------------------------------------


def chop_mid_turn(text: str, rng: random.Random) -> Optional[str]:
    """Truncate `text` at a random non-final character boundary.

    Returns None when the input is too short to chop meaningfully
    (length < 4 chars). The caller drops these — they would produce
    near-empty negatives that the classifier can't learn from.
    """
    if len(text) < 4:
        return None
    # Bias toward chops in the middle 80% — avoid the first char (always
    # mid-token) and last char (basically identical to positive).
    lo = max(1, len(text) // 10)
    hi = len(text) - 1
    if hi <= lo:
        return None
    cut = rng.randrange(lo, hi)
    chopped = text[:cut].rstrip()
    return chopped or None


# ---------------------------------------------------------------------------
# Privacy filter
# ---------------------------------------------------------------------------


class _PrivacyFilter:
    """Lazy loader for the canonical privacy filter.

    Mandatory per packages/training/AGENTS.md §3. If
    `validate_corpus.py` exposes a `privacy_filter(text) -> bool`
    callable we use it; otherwise we fall back to a strict in-process
    check that drops obvious PII patterns (emails, phone numbers, SSNs).
    The fallback is intentionally conservative — better to drop a
    legitimate record than to leak PII into a training corpus.
    """

    def __init__(self) -> None:
        self._impl = self._load_canonical()

    @staticmethod
    def _load_canonical() -> Optional[callable]:
        try:
            from scripts.validate_corpus import privacy_filter  # type: ignore

            return privacy_filter
        except Exception:
            return None

    def __call__(self, text: str) -> bool:
        if self._impl is not None:
            try:
                return bool(self._impl(text))
            except Exception as exc:
                logger.warning("canonical privacy filter raised %s; falling back", exc)
        return self._fallback(text)

    @staticmethod
    def _fallback(text: str) -> bool:
        import re

        # Bare-minimum PII patterns. The canonical filter is preferred.
        if re.search(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b", text):
            return False
        if re.search(r"\b\d{3}[- .]\d{2}[- .]\d{4}\b", text):  # SSN
            return False
        if re.search(r"\b\+?\d[\d\s().-]{8,}\b", text):  # phone
            return False
        return True


# ---------------------------------------------------------------------------
# Corpus builder
# ---------------------------------------------------------------------------


@dataclass
class BuildStats:
    conversations_seen: int = 0
    turns_seen: int = 0
    positives: int = 0
    negatives: int = 0
    privacy_dropped: int = 0
    chop_skipped: int = 0


def build_corpus(
    sources: list[tuple[str, Path]],
    rng: random.Random,
    neg_ratio: float,
    privacy: _PrivacyFilter,
    min_chars: int = 4,
) -> tuple[list[EotRecord], BuildStats]:
    """Walk every source and emit EotRecords.

    `sources` is a list of (source_name, path). The format is detected
    by extension: `.jsonl` → JSONL turns, `.srt` → subtitle, otherwise
    plain dialog (one turn per line, blank lines separate conversations).
    """
    out: list[EotRecord] = []
    stats = BuildStats()

    for source_name, path in sources:
        if not path.exists():
            logger.warning("source %s: %s does not exist", source_name, path)
            continue

        if path.suffix.lower() == ".jsonl":
            stream = read_jsonl_turns(path)
        elif path.suffix.lower() == ".srt":
            stream = read_srt(path)
        else:
            stream = read_plain_dialog(path)

        for convo_id, turns in stream:
            stats.conversations_seen += 1
            for turn in turns:
                stats.turns_seen += 1
                if len(turn) < min_chars:
                    continue
                if not privacy(turn):
                    stats.privacy_dropped += 1
                    continue
                # Positive: full turn, formatted with chat template.
                out.append(
                    EotRecord(
                        text=apply_gemma_user_template(turn),
                        label=1,
                        source=source_name,
                        conversation_id=convo_id,
                    )
                )
                stats.positives += 1

                # Negatives: synthesize `neg_ratio` chops per positive.
                n_negatives = int(neg_ratio + (1 if rng.random() < (neg_ratio % 1) else 0))
                for _ in range(n_negatives):
                    chopped = chop_mid_turn(turn, rng)
                    if chopped is None:
                        stats.chop_skipped += 1
                        continue
                    if not privacy(chopped):
                        stats.privacy_dropped += 1
                        continue
                    out.append(
                        EotRecord(
                            text=apply_gemma_user_template(chopped),
                            label=0,
                            source=source_name,
                            conversation_id=convo_id,
                        )
                    )
                    stats.negatives += 1

    return out, stats


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------


def write_parquet(records: list[EotRecord], out_path: Path) -> None:
    try:
        import pyarrow as pa  # type: ignore
        import pyarrow.parquet as pq  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "pyarrow is required for Parquet output. Install with "
            "`pip install pyarrow`, or pass --format jsonl."
        ) from exc

    table = pa.table(
        {
            "text": [r.text for r in records],
            "label": [r.label for r in records],
            "source": [r.source for r in records],
            "conversation_id": [r.conversation_id for r in records],
        }
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, out_path)


def write_jsonl(records: list[EotRecord], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        for rec in records:
            handle.write(
                json.dumps(
                    {
                        "text": rec.text,
                        "label": rec.label,
                        "source": rec.source,
                        "conversation_id": rec.conversation_id,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build an EOT training corpus.")
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        metavar="NAME:PATH",
        help=(
            "Source spec `name:path`. Repeatable. Format detected by "
            "extension: .jsonl → JSONL turns, .srt → subtitle, "
            "anything else → plain dialog (one turn per line)."
        ),
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output file path. Format follows --format.",
    )
    parser.add_argument(
        "--format",
        choices=["parquet", "jsonl"],
        default="parquet",
        help="Output format (default: parquet).",
    )
    parser.add_argument(
        "--neg-ratio",
        type=float,
        default=1.0,
        help="Negatives per positive (default 1.0 = 1:1).",
    )
    parser.add_argument(
        "--min-chars",
        type=int,
        default=4,
        help="Skip turns shorter than this many characters (default 4).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="RNG seed for negative-chop reproducibility (default 42).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser.parse_args(argv)


def _parse_sources(specs: list[str]) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for spec in specs:
        if ":" not in spec:
            raise SystemExit(
                f"--source must be NAME:PATH; got {spec!r}"
            )
        name, raw = spec.split(":", 1)
        if not name or not raw:
            raise SystemExit(f"--source must have non-empty name and path: {spec!r}")
        out.append((name, Path(raw)))
    return out


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    sources = _parse_sources(args.source)
    rng = random.Random(args.seed)
    privacy = _PrivacyFilter()
    records, stats = build_corpus(
        sources=sources,
        rng=rng,
        neg_ratio=args.neg_ratio,
        privacy=privacy,
        min_chars=args.min_chars,
    )

    if not records:
        logger.error("no records produced from %d source(s); aborting", len(sources))
        return 1

    if args.format == "parquet":
        write_parquet(records, args.out)
    else:
        write_jsonl(records, args.out)

    logger.info(
        "wrote %d records to %s (positives=%d negatives=%d "
        "conversations=%d turns=%d privacy_dropped=%d chop_skipped=%d)",
        len(records),
        args.out,
        stats.positives,
        stats.negatives,
        stats.conversations_seen,
        stats.turns_seen,
        stats.privacy_dropped,
        stats.chop_skipped,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
