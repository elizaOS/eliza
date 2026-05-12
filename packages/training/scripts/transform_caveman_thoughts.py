#!/usr/bin/env python3
"""Caveman-compress the `thought:` field in TOON expectedResponse.

For task_types that contain a `thought:` block (reply, agent_trace, tool_call,
mcp_tool_call), extract the thought string, compress it via
`scripts.lib.caveman.compress`, and write back.

Keeps the original alongside in
`data/intermediate/caveman_thoughts.jsonl` keyed by line index, so we have a
mapping from {idx: {original, caveman}} for review/rollback.

Reads `data/final/train_deslopped.jsonl` (or whatever upstream is current)
Writes `data/final/train_caveman.jsonl`.

The compress function falls back to the original text when compression
collapses below 3 tokens, so we never produce a degenerate thought.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.caveman import compress, compression_ratio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_deslopped.jsonl"
DST = ROOT / "data" / "final" / "train_caveman.jsonl"
INTERMEDIATE = ROOT / "data" / "intermediate" / "caveman_thoughts.jsonl"
MANIFEST = ROOT / "data" / "final" / "manifest_caveman.json"

THOUGHT_TASK_TYPES = {"reply", "agent_trace", "tool_call", "mcp_tool_call"}

# Match `thought: "<value>"` line in TOON. Same shape as transform_deslop.
TOON_THOUGHT_RE = re.compile(
    r'(^|\n)(thought:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
    re.DOTALL,
)
TOON_QUOTED_THOUGHT_RE = re.compile(
    r'(^|\n)("thought":\s*)("(?:[^"\\]|\\.)*")(\s*(?=,|\n|$))',
    re.DOTALL,
)


def replace_thought(toon: str, *, intermediate_writer, idx: int, stats: dict) -> str:
    """Replace `thought: "<x>"` with caveman version. Records original."""
    captured: list[tuple[str, str]] = []

    def _replace(match: re.Match) -> str:
        prefix, key, quoted, suffix = match.groups()
        try:
            inner = json.loads(quoted)
        except json.JSONDecodeError:
            return match.group(0)
        if not isinstance(inner, str) or not inner.strip():
            return match.group(0)
        compressed = compress(inner)
        captured.append((inner, compressed))
        if compressed == inner:
            stats["unchanged"] = stats.get("unchanged", 0) + 1
            return match.group(0)
        stats["compressed"] = stats.get("compressed", 0) + 1
        ratio = compression_ratio(inner, compressed)
        stats["ratio_sum"] = stats.get("ratio_sum", 0.0) + ratio
        return f"{prefix}{key}{json.dumps(compressed, ensure_ascii=False)}{suffix}"

    new_toon = TOON_THOUGHT_RE.sub(_replace, toon)
    new_toon = TOON_QUOTED_THOUGHT_RE.sub(_replace, new_toon)

    for original, compressed in captured:
        intermediate_writer.write(json.dumps({
            "idx": idx,
            "original": original,
            "caveman": compressed,
        }, ensure_ascii=False) + "\n")

    return new_toon


def caveman_record(rec: dict, *, intermediate_writer, idx: int, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type") or rec.get("task_type", "")
    if tt not in THOUGHT_TASK_TYPES:
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_er = replace_thought(er, intermediate_writer=intermediate_writer, idx=idx, stats=stats)
    if new_er != er:
        rec["expectedResponse"] = new_er
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    INTERMEDIATE.parent.mkdir(parents=True, exist_ok=True)
    stats = {"total": 0, "decode_errors": 0, "compressed": 0, "unchanged": 0,
             "records_changed": 0, "ratio_sum": 0.0}
    print(f"[caveman] {SRC} -> {DST}", file=sys.stderr)
    print(f"[caveman] intermediate -> {INTERMEDIATE}", file=sys.stderr)
    with SRC.open() as fin, DST.open("w") as fout, INTERMEDIATE.open("w") as fmid:
        for idx, line in enumerate(fin):
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = caveman_record(rec, intermediate_writer=fmid, idx=idx, stats=stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 100000 == 0:
                avg = stats["ratio_sum"] / max(1, stats["compressed"])
                print(
                    f"[caveman] {stats['total']:>7d}  "
                    f"compressed={stats['compressed']:>6d} "
                    f"unchanged={stats['unchanged']:>6d} "
                    f"avg_ratio={avg:.2f}",
                    file=sys.stderr,
                )
    if stats["compressed"]:
        stats["avg_ratio"] = stats["ratio_sum"] / stats["compressed"]
    MANIFEST.write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
