#!/usr/bin/env python3
"""Scan train.jsonl for placeholder/trivial `thought:` lines that pass the
shallow non-empty check but provide zero supervised reasoning signal.

The trivial set is the 9 phrases identified during the deep audit. Output
mirrors `audit_v7_empty.py`: per-source JSONL dumps under
`data/synthesized/review/trivial_by_source/<safe-source>.jsonl` plus a
summary table grouped by source.

Each output line:
  {"key": "<line_idx>", "source": "<src>", "task_type": "...",
   "currentMessage_preview": "...", "expectedResponse_preview": "...",
   "trivial_thought": "..."}

Previews are capped at 600 chars each.

Defaults to scanning `data/final/train.jsonl` but accepts `--input` to
re-run on `train_final.jsonl` for verification.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TRAIN = ROOT / "data" / "final" / "train.jsonl"
OUT_DIR = ROOT / "data" / "synthesized" / "review" / "trivial_by_source"
SUMMARY_OUT = ROOT / "data" / "synthesized" / "review" / "trivial_summary.json"

TASKS_WITH_THOUGHT = {"reply", "agent_trace", "tool_call", "mcp_tool_call"}

# Single source of truth lives in scripts/lib/eliza_record.py — every tool
# that scrubs or scans the corpus for default-thought leaks imports it from
# there so the lists never drift.
sys.path.insert(0, str(ROOT))
from scripts.lib.eliza_record import DEFAULT_THOUGHT_LEAKS  # noqa: E402

TRIVIAL_THOUGHTS = frozenset(DEFAULT_THOUGHT_LEAKS)


def extract_thought(payload: str) -> str | None:
    """Pull out the value of the first `thought:` (or `"thought":`) line.

    Returns the value with surrounding quotes stripped, or None if the
    record has no thought line.
    """
    if not payload:
        return None
    for line in payload.splitlines():
        s = line.strip()
        key = None
        if s.startswith("thought:"):
            key = "thought:"
        elif s.startswith('"thought":'):
            key = '"thought":'
        if not key:
            continue
        v = s[len(key):].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        return v
    return None


def is_trivial(thought: str | None) -> bool:
    if thought is None:
        return False
    return thought.strip() in TRIVIAL_THOUGHTS


def safe_name(src: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", src)[:80]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=DEFAULT_TRAIN,
                    help="path to train.jsonl (default: data/final/train.jsonl)")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR,
                    help="dump per-source JSONL here (default: data/synthesized/review/trivial_by_source)")
    ap.add_argument("--summary", type=Path, default=SUMMARY_OUT,
                    help="path to summary JSON (default: data/synthesized/review/trivial_summary.json)")
    ap.add_argument("--no-dump", action="store_true",
                    help="skip per-source dumps, just print + write summary")
    args = ap.parse_args()

    if not args.no_dump:
        args.out_dir.mkdir(parents=True, exist_ok=True)

    by_source: dict[str, list[dict]] = defaultdict(list)
    by_source_total: dict[str, int] = defaultdict(int)
    by_thought: dict[str, int] = defaultdict(int)
    task_type_trivial: dict[str, int] = defaultdict(int)
    grand_total_lines = 0
    grand_total_with_thought = 0

    print(f"[scan] reading {args.input}", file=sys.stderr)
    with args.input.open() as f:
        for idx, line in enumerate(f):
            grand_total_lines = idx + 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = rec.get("metadata") or {}
            tt = md.get("task_type") or rec.get("task_type") or ""
            if tt not in TASKS_WITH_THOUGHT:
                continue
            src = md.get("source_dataset") or "unknown"
            by_source_total[src] += 1
            er = rec.get("expectedResponse") or ""
            thought = extract_thought(er)
            # count anything with a non-empty thought as "with thought"
            if thought and thought.strip():
                grand_total_with_thought += 1
            if not is_trivial(thought):
                continue
            by_thought[thought.strip()] += 1
            task_type_trivial[tt] += 1
            cm = ((rec.get("currentMessage") or {}).get("content") or "")
            by_source[src].append({
                "key": str(idx),
                "source": src,
                "task_type": tt,
                "currentMessage_preview": cm[:600],
                "expectedResponse_preview": er[:600],
                "trivial_thought": thought.strip(),
            })
            if idx % 200000 == 0 and idx > 0:
                print(f"[scan] {idx} lines, trivial so far: "
                      f"{sum(len(v) for v in by_source.values())}",
                      file=sys.stderr)

    if not args.no_dump:
        for src, recs in by_source.items():
            out = args.out_dir / f"{safe_name(src)}.jsonl"
            with out.open("w") as f:
                for r in recs:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")

    grand_trivial = sum(len(v) for v in by_source.values())
    grand_total_reasoning = sum(by_source_total.values())
    non_trivial_with_thought = grand_total_with_thought - grand_trivial

    summary = {
        "input": str(args.input),
        "lines_read": grand_total_lines,
        "reasoning_records": grand_total_reasoning,
        "with_any_thought": grand_total_with_thought,
        "trivial_records": grand_trivial,
        "non_trivial_with_thought": non_trivial_with_thought,
        "non_trivial_pct_of_reasoning": round(
            100 * non_trivial_with_thought / max(1, grand_total_reasoning), 3
        ),
        "trivial_pct_of_reasoning": round(
            100 * grand_trivial / max(1, grand_total_reasoning), 3
        ),
        "task_type_trivial": dict(task_type_trivial),
        "trivial_phrase_counts": dict(
            sorted(by_thought.items(), key=lambda kv: -kv[1])
        ),
        "by_source": {
            src: {
                "total_reasoning": by_source_total[src],
                "trivial": len(by_source[src]),
                "trivial_pct": round(
                    100 * len(by_source[src]) / max(1, by_source_total[src]), 2
                ),
            }
            for src in sorted(by_source_total.keys())
            if len(by_source[src]) > 0
        },
    }
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, indent=2, sort_keys=True))

    print("\n=== TRIVIAL THOUGHT SCAN ===", file=sys.stderr)
    print(f"input:                         {args.input}", file=sys.stderr)
    print(f"reasoning records:        {grand_total_reasoning:>12,d}", file=sys.stderr)
    print(f"with any thought:         {grand_total_with_thought:>12,d}", file=sys.stderr)
    print(f"trivial records:          {grand_trivial:>12,d} "
          f"({summary['trivial_pct_of_reasoning']}%)", file=sys.stderr)
    print(f"non-trivial w/ thought:   {non_trivial_with_thought:>12,d} "
          f"({summary['non_trivial_pct_of_reasoning']}%)", file=sys.stderr)
    if by_thought:
        print("\nby trivial phrase:", file=sys.stderr)
        for phrase, n in sorted(by_thought.items(), key=lambda kv: -kv[1]):
            print(f"  {n:>8,d}  {phrase!r}", file=sys.stderr)

    if by_source:
        print("\nby source (top 40 by trivial count):", file=sys.stderr)
        rows = sorted(
            by_source.items(),
            key=lambda kv: -len(kv[1]),
        )
        print(f"{'source':50s} {'reasoning':>10s} {'trivial':>10s} {'pct':>7s}",
              file=sys.stderr)
        for src, recs in rows[:40]:
            n = len(recs)
            if n == 0:
                continue
            tot = by_source_total[src]
            pct = 100 * n / max(1, tot)
            print(f"{src[:50]:50s} {tot:>10,d} {n:>10,d} {pct:>6.2f}%",
                  file=sys.stderr)

    print(f"\nwrote {args.summary}", file=sys.stderr)
    if not args.no_dump:
        print(f"wrote per-source trivial dumps in {args.out_dir}/ "
              f"({len(by_source)} files)", file=sys.stderr)


if __name__ == "__main__":
    main()
