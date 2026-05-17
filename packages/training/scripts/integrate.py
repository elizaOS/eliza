#!/usr/bin/env python3
"""Integrate the final training corpus: merge `train_diversified.jsonl` +
`harness/*.jsonl` + `scambench/scambench.jsonl` into `train_final.jsonl`.

Inputs (existence-required):
  data/final/train_diversified.jsonl
Inputs (optional, merged if present):
  data/synthesized/harness/*.jsonl     (skip <action>.jsonl with 0 records)
  data/synthesized/scambench/scambench.jsonl
Optional final step:
  Apply trivial-thought repack via data/synthesized/manual_reasoning/thoughts.jsonl
  (round-3 synth output); only does this step if ELIZA_INTEGRATE_TRIVIAL=1.
  Replacement thoughts are caveman-compressed before injection.

Output:
  data/final/train_final.jsonl
  data/final/manifest_final.json
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "data" / "final" / "train_final.jsonl"
MANIFEST = ROOT / "data" / "final" / "manifest_final.json"

DIVERSIFIED = ROOT / "data" / "final" / "train_diversified.jsonl"
HARNESS_DIR = ROOT / "data" / "synthesized" / "harness"
SCAMBENCH = ROOT / "data" / "synthesized" / "scambench" / "scambench.jsonl"
THOUGHTS = ROOT / "data" / "synthesized" / "manual_reasoning" / "thoughts.jsonl"


sys.path.insert(0, str(ROOT / "scripts"))
from lib.caveman import compress as caveman_compress  # noqa: E402


def stream_jsonl(path: Path):
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_thoughts() -> dict[str, str]:
    """key (str line index) -> caveman-compressed thought.

    Round-3 synth produces verbose thoughts; we caveman-compress on load
    so the replacement is consistent with how prior thoughts were treated
    by transform_caveman_thoughts.py.
    """
    out: dict[str, str] = {}
    if not THOUGHTS.exists():
        return out
    for r in stream_jsonl(THOUGHTS):
        k = r.get("key")
        t = r.get("thought")
        if k and isinstance(t, str) and t.strip():
            out[str(k)] = caveman_compress(t)
    return out


def maybe_inject_thought(rec: dict, idx: int, thoughts: dict) -> dict:
    """Replace `thought:` if record idx is in thoughts map."""
    key = str(idx)
    if key not in thoughts:
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    new_thought = thoughts[key]
    # Use same regex as transform_caveman_thoughts.py
    import re
    pat = re.compile(
        r'(^|\n)(thought:\s*)("(?:[^"\\]|\\.)*")(\s*(?=\n|$))',
        re.DOTALL,
    )
    quoted = json.dumps(new_thought, ensure_ascii=False)
    new_er, n = pat.subn(rf"\1\2{re.escape(quoted)}\4", er, count=1)
    if n == 0:
        # no thought field — prepend one
        new_er = f"thought: {quoted}\n{er}"
    rec["expectedResponse"] = new_er
    return rec


def main() -> int:
    if not DIVERSIFIED.exists():
        print(f"error: {DIVERSIFIED} missing — run pipeline first", file=sys.stderr)
        return 2

    apply_trivial = os.environ.get("ELIZA_INTEGRATE_TRIVIAL", "0") == "1"
    thoughts: dict[str, str] = load_thoughts() if apply_trivial else {}
    print(f"[integrate] loaded {len(thoughts)} thoughts", file=sys.stderr)

    stats = {"main": 0, "harness": 0, "scambench": 0, "trivial_replaced": 0}
    with DST.open("w") as fout:
        for idx, rec in enumerate(stream_jsonl(DIVERSIFIED)):
            if apply_trivial:
                if str(idx) in thoughts:
                    rec = maybe_inject_thought(rec, idx, thoughts)
                    stats["trivial_replaced"] += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            stats["main"] += 1
            if stats["main"] % 100000 == 0:
                print(f"[integrate] main {stats['main']}", file=sys.stderr)

        if HARNESS_DIR.exists():
            for path in sorted(HARNESS_DIR.glob("*.jsonl")):
                for rec in stream_jsonl(path):
                    fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    stats["harness"] += 1
            print(f"[integrate] harness {stats['harness']}", file=sys.stderr)

        if SCAMBENCH.exists():
            for rec in stream_jsonl(SCAMBENCH):
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats["scambench"] += 1
            print(f"[integrate] scambench {stats['scambench']}", file=sys.stderr)

    stats["total"] = stats["main"] + stats["harness"] + stats["scambench"]
    MANIFEST.write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
