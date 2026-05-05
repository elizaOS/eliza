"""Transform claude-distill records into Phase-2 reply records.

The claude-distill corpus (Kassadin88/Claude-Distills and the like) ships
each record with `expectedResponse` set to the raw envelope
`<think>{reasoning}</think>{final answer}`. The elizaOS runtime never emits
that shape — the planner stage produces a TOON envelope and the reply stage
produces a slim `{thought, text}` (see PIPELINE_SCHEMAS.md §3, §1).

`docs/dataset/COVERAGE_AUDIT.md` flags the raw `<think>...</think>` form as
out-of-band and requires it to be transformed into a Phase-2 reply
(`task_type=reply`) before the corpus is used for SFT.

This transform reads a normalized claude-distill JSONL (one canonical
`ElizaRecord` per line) and rewrites each row as a planner-envelope reply:
the `<think>` body is lifted into `thought:` (truncated to ≤240 chars,
collapsed to a single line), the post-think text is placed in `text:`, the
canonical action list is `[{name: REPLY, params: {}}]`, providers is empty,
and `simple: true`. `metadata.task_type` is rewritten to `reply` and a
`metadata.transformed_from = "claude_distill"` breadcrumb is added so the
provenance is visible to downstream tooling.

The transform never modifies the input — output is written to a sibling
JSONL file (default `<input>-as-reply.jsonl`) so the original is preserved
for forensic comparison.

Usage:
    python3 scripts/transform_claude_distill_to_reply.py \\
        --input data/normalized/claude-distills.jsonl \\
        --output data/normalized/claude-distills-as-reply.jsonl

    # smoke test against a small fixture
    python3 scripts/transform_claude_distill_to_reply.py \\
        --input /tmp/fixture.jsonl --output /tmp/out.jsonl --max 100
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
log = logging.getLogger("transform_claude_distill")

# Match `<think>...</think>` non-greedily across newlines. Some distills
# spell the marker as `<thinking>` or with different casing, so we accept a
# small set of variants and normalize on the way out.
_THINK_RE = re.compile(
    r"<\s*(think|thinking)\s*>(.*?)<\s*/\s*\1\s*>",
    flags=re.IGNORECASE | re.DOTALL,
)

_THOUGHT_MAX_CHARS = 240


def _split_think_envelope(raw: str) -> tuple[str, str] | None:
    """Return `(think_body, final_answer)` or None if no `<think>` block.

    Multiple `<think>` blocks are concatenated (rare but observed in the
    Claude-3-Opus distills). Whitespace around both sides is stripped.
    """
    if not raw:
        return None
    matches = list(_THINK_RE.finditer(raw))
    if not matches:
        return None
    think_parts = [m.group(2).strip() for m in matches if m.group(2).strip()]
    if not think_parts:
        return None
    # Remove every <think> block from the source; what's left is the final
    # answer. The runtime reply target never carries `<think>` markers.
    final_answer = _THINK_RE.sub("", raw).strip()
    return ("\n\n".join(think_parts).strip(), final_answer)


def _to_one_line_thought(body: str) -> str:
    """Collapse a (possibly multi-line) reasoning trace to a single ≤240-char
    line suitable for the slim TOON `thought:` field. Whitespace runs are
    folded to a single space; the truncated form ends on a word boundary
    when possible so the model isn't trained on jagged token boundaries.
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


def transform(
    *,
    input_path: Path,
    output_path: Path,
    max_records: int | None,
) -> dict[str, int]:
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
                    # Insert at the head so the encoded TOON keeps the
                    # canonical key order (`thought, actions, providers,
                    # text, simple`).
                    envelope = {"thought": thought, **envelope}

                meta = dict(rec.get("metadata") or {})
                meta["task_type"] = "reply"
                meta["transformed_from"] = "claude_distill"

                rec_out = dict(rec)
                rec_out["expectedResponse"] = encoder.encode(envelope)
                rec_out["metadata"] = meta

                out.write(json.dumps(rec_out, ensure_ascii=False, separators=(",", ":")) + "\n")
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
                    help="normalized claude-distills JSONL")
    ap.add_argument("--output", type=Path, required=True,
                    help="output JSONL — will be overwritten")
    ap.add_argument("--max", type=int, default=None, dest="max_records",
                    help="cap output records (smoke testing)")
    args = ap.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)

    log.info("transforming %s → %s", args.input, args.output)
    stats = transform(
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
