"""Transform `task_type=reasoning_cot` records.

The reasoning_cot family (kimi, glm, opus, deepseek, qwen reasoning corpora)
ships ~1M records whose `expectedResponse` is the bare envelope
`<think>{trace}</think>{final}`. The runtime never emits this shape — see
`docs/dataset/RUNTIME_PHASES.md` and `docs/dataset/COVERAGE_AUDIT.md`. The
audit decision (2026-05-04, COVERAGE_AUDIT.md §"`reasoning_cot` — drop or
transform") is **drop** for the main eliza-1 SFT mix.

This script implements both options so the choice stays operator-controlled:

  - `--mode drop` (default) reads the input, writes nothing, and reports
    the count of records that would be dropped. Used as the audit/dry-run
    gate before a pack.
  - `--mode reshape` lifts each record into a Phase-2 reply: the `<think>`
    body becomes a single-line `thought` (≤240 chars), the post-think text
    becomes the `text` field, the action list is the canonical
    `[{name: REPLY, params: {}}]`, `simple: true`, and `metadata.task_type`
    is rewritten to `reply`. A `metadata.transformed_from = "reasoning_cot"`
    breadcrumb is added so provenance is visible to downstream tooling.

Mirrors `scripts/transform_claude_distill_to_reply.py`.

Usage:
    # default — count-only audit (no output written)
    python3 scripts/transform_reasoning_cot.py \\
        --input data/normalized/kimi-k25-reasoning-1m.jsonl

    # promote to Phase 2 reply (rare; the audit prefers drop)
    python3 scripts/transform_reasoning_cot.py \\
        --input data/normalized/kimi-k25-reasoning-1m.jsonl \\
        --output data/normalized/kimi-k25-as-reply.jsonl \\
        --mode reshape
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.toon import ToonEncoder  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("transform_reasoning_cot")

# Match `<think>...</think>` (and `<thinking>...</thinking>`) non-greedily
# across newlines. Casing varies across the kimi/glm/opus/deepseek/qwen
# distills; we accept both spellings and lowercase the marker on output.
_THINK_RE = re.compile(
    r"<\s*(think|thinking)\s*>(.*?)<\s*/\s*\1\s*>",
    flags=re.IGNORECASE | re.DOTALL,
)

_THOUGHT_MAX_CHARS = 240


def _split_think_envelope(raw: str) -> tuple[str, str] | None:
    """Return `(think_body, final_answer)` or None if no `<think>` block.

    Multiple `<think>` blocks are concatenated. Whitespace around both
    sides is stripped.
    """
    if not raw:
        return None
    matches = list(_THINK_RE.finditer(raw))
    if not matches:
        return None
    think_parts = [m.group(2).strip() for m in matches if m.group(2).strip()]
    if not think_parts:
        return None
    final_answer = _THINK_RE.sub("", raw).strip()
    return ("\n\n".join(think_parts).strip(), final_answer)


def _to_one_line_thought(body: str) -> str:
    """Collapse the reasoning trace to a single ≤240-char line.

    Whitespace runs fold to a single space; the truncated form ends on a
    word boundary when possible so the model isn't trained on jagged
    token boundaries.
    """
    flat = re.sub(r"\s+", " ", body).strip()
    if len(flat) <= _THOUGHT_MAX_CHARS:
        return flat
    cut = flat[:_THOUGHT_MAX_CHARS]
    space = cut.rfind(" ")
    if space >= int(_THOUGHT_MAX_CHARS * 0.6):
        cut = cut[:space]
    return cut.rstrip()


def _iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                log.warning("skipping line %d: %s", ln, e)


def transform_drop(*, input_path: Path) -> dict[str, int]:
    """Count records that would be dropped. Writes nothing."""
    total = 0
    droppable = 0
    for rec in _iter_jsonl(input_path):
        total += 1
        if not isinstance(rec, dict):
            continue
        droppable += 1
    return {"total": total, "would_drop": droppable, "kept": 0}


def transform_reshape(
    *,
    input_path: Path,
    output_path: Path,
    max_records: int | None,
) -> dict[str, int]:
    """Reshape each record into a Phase-2 reply envelope."""
    encoder = ToonEncoder()
    kept = 0
    dropped_no_think = 0
    dropped_empty_final = 0
    dropped_other = 0
    try:
        with output_path.open("w", encoding="utf-8") as out:
            for rec in _iter_jsonl(input_path):
                if not isinstance(rec, dict):
                    dropped_other += 1
                    continue
                expected = rec.get("expectedResponse")
                if not isinstance(expected, str) or not expected.strip():
                    dropped_other += 1
                    continue
                split = _split_think_envelope(expected)
                if split is None:
                    dropped_no_think += 1
                    continue
                think_body, final_answer = split
                if not final_answer:
                    dropped_empty_final += 1
                    continue
                thought = _to_one_line_thought(think_body)
                text = final_answer.strip()

                envelope: dict[str, Any] = {
                    "actions": [{"name": "REPLY", "params": {}}],
                    "providers": [],
                    "text": text,
                    "simple": True,
                }
                if thought:
                    envelope = {"thought": thought, **envelope}

                meta = dict(rec.get("metadata") or {})
                meta["task_type"] = "reply"
                meta["transformed_from"] = "reasoning_cot"

                rec_out = dict(rec)
                rec_out["expectedResponse"] = encoder.encode(envelope)
                rec_out["metadata"] = meta

                out.write(json.dumps(rec_out, ensure_ascii=False,
                                     separators=(",", ":")) + "\n")
                kept += 1
                if max_records and kept >= max_records:
                    break
    finally:
        encoder.close()
    return {
        "kept": kept,
        "dropped_no_think": dropped_no_think,
        "dropped_empty_final": dropped_empty_final,
        "dropped_other": dropped_other,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, required=True,
                    help="normalized reasoning_cot JSONL")
    ap.add_argument("--output", type=Path,
                    help="output JSONL (required when --mode reshape)")
    ap.add_argument("--mode", choices=("drop", "reshape"), default="drop",
                    help="drop=count only (default); reshape=write Phase-2 reply records")
    ap.add_argument("--max", type=int, default=None, dest="max_records",
                    help="cap output records (smoke testing)")
    args = ap.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2

    if args.mode == "drop":
        log.info("mode=drop: counting %s (no output written)", args.input)
        stats = transform_drop(input_path=args.input)
        log.info("done: total=%d would_drop=%d", stats["total"], stats["would_drop"])
        return 0

    # reshape
    if args.output is None:
        log.error("--output is required when --mode reshape")
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    log.info("mode=reshape: %s → %s", args.input, args.output)
    stats = transform_reshape(
        input_path=args.input,
        output_path=args.output,
        max_records=args.max_records,
    )
    log.info(
        "done: kept=%d dropped_no_think=%d dropped_empty_final=%d dropped_other=%d",
        stats["kept"], stats["dropped_no_think"],
        stats["dropped_empty_final"], stats["dropped_other"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
