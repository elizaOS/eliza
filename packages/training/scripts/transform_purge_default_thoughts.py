"""Purge the literal default-thought strings from packed train.jsonl.

The dataset adapters were updated to use a varied thought-phrasing pool, but
existing `data/normalized/*.jsonl` files were generated before the fix and
still contain literal strings like `"Reply to the user."` injected as the
model's reasoning. Re-normalizing 75 GB to fix this is wasteful when we can
post-process the packed train.jsonl directly.

This script walks train.jsonl line by line. For each record where
`expectedResponse` starts with `thought: <literal default>`, replaces just
that line with a varied phrasing picked deterministically from the
adapter's pool (seeded by the user message).

Output: rewrites train.jsonl (and val.jsonl) in place via atomic temp file.

Usage:
    .venv/bin/python scripts/transform_purge_default_thoughts.py
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.adapters import (  # noqa: E402
    _picked_thought,
    _REPLY_THOUGHT_POOL,
    _TOOL_THOUGHT_POOL,
    _SHELL_THOUGHT_POOL,
    _IGNORE_THOUGHT_POOL,
    _AGENT_TRACE_THOUGHT_POOL,
)
from lib.eliza_record import DEFAULT_THOUGHT_LEAKS  # noqa: E402

assert "Reply to the user." in DEFAULT_THOUGHT_LEAKS, (
    "DEFAULT_THOUGHT_LEAKS lost its canonical entry — see lib/eliza_record.py"
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("purge")

# Map from old literal → pool to use for replacement
_LEAK_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    ("thought: Reply to the user.", _REPLY_THOUGHT_POOL),
    ("thought: Call the tool to satisfy the request.", _TOOL_THOUGHT_POOL),
    ("thought: Run the command to satisfy the request.", _SHELL_THOUGHT_POOL),
    ('thought: "This message is not for me — ignore."', _IGNORE_THOUGHT_POOL),
    ("thought: This message is not for me — ignore.", _IGNORE_THOUGHT_POOL),
    ("thought: Continue the agent task.", _AGENT_TRACE_THOUGHT_POOL),
]


def rewrite_expected_response(er: str, seed: str) -> tuple[str, bool]:
    """Return (rewritten, was_leaked). Replaces the first thought line if
    it's a known literal default."""
    if not er:
        return er, False
    lines = er.split("\n", 1)
    first = lines[0]
    rest = lines[1] if len(lines) > 1 else ""
    for prefix, pool in _LEAK_PATTERNS:
        if first.startswith(prefix):
            varied = _picked_thought(pool, seed)
            new_first = f"thought: {varied}"
            return f"{new_first}\n{rest}" if rest else new_first, True
    return er, False


def process_file(path: Path) -> tuple[int, int]:
    """Returns (records, rewritten)."""
    if not path.exists():
        log.warning("missing %s; skipping", path)
        return 0, 0
    tmp = path.with_suffix(".jsonl.purged.tmp")
    n_total = n_rewritten = 0
    with path.open("r", encoding="utf-8") as f, \
         tmp.open("w", encoding="utf-8") as g:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            n_total += 1
            er = rec.get("expectedResponse") or ""
            seed = (rec.get("currentMessage") or {}).get("content", "") or ""
            new_er, was_leaked = rewrite_expected_response(er, seed)
            if was_leaked:
                rec["expectedResponse"] = new_er
                n_rewritten += 1
            g.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return n_total, n_rewritten


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--final-dir", type=Path,
                    default=ROOT / "data" / "final")
    args = ap.parse_args()

    grand_total = grand_rewritten = 0
    for split in ("train", "val", "test"):
        path = args.final_dir / f"{split}.jsonl"
        log.info("processing %s", path)
        n, r = process_file(path)
        grand_total += n
        grand_rewritten += r
        pct = 100 * r / max(1, n)
        log.info("  %s: %d records, %d rewritten (%.2f%%)",
                 split, n, r, pct)
    log.info("DONE: %d/%d records rewritten across all splits (%.2f%%)",
             grand_rewritten, grand_total,
             100 * grand_rewritten / max(1, grand_total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
