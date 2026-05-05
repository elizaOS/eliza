#!/usr/bin/env python3
"""Splice synthesized reasoning thoughts into train.jsonl -> v9.

This is round-3 of the reasoning augmentation pipeline. Differs from
`repack_with_synth_thoughts.py` (v7) in that it OVERWRITES `thought:` lines
that match the 9 trivial placeholders, in addition to filling in records
that have no thought line at all.

Reads:
  data/final/train.jsonl                            (current pack v8)
  data/synthesized/manual_reasoning/thoughts.jsonl  (line_idx -> thought)

Writes:
  data/final/train_v9.jsonl
  data/final/manifest_v9.json
"""
from __future__ import annotations

import argparse
import json
import re as _re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.toon import ToonEncoder, ToonDecoder  # noqa: E402
from lib.eliza_record import DEFAULT_THOUGHT_LEAKS  # noqa: E402

TRAIN_IN = ROOT / "data" / "final" / "train.jsonl"
THOUGHTS = ROOT / "data" / "synthesized" / "manual_reasoning" / "thoughts.jsonl"
TRAIN_OUT = ROOT / "data" / "final" / "train_v9.jsonl"
MANIFEST_OUT = ROOT / "data" / "final" / "manifest_v9.json"

# Single source of truth for trivial / leaked default-thought literals lives
# in lib/eliza_record.DEFAULT_THOUGHT_LEAKS.
TRIVIAL_THOUGHTS = frozenset(DEFAULT_THOUGHT_LEAKS)

_BAD_PATTERNS = [
    r'\bthe agent\b',
    r'\bthe assistant\b',
    r'\bthe (response|reply)\b',
    r'\bthe (reasoning|thought)\b',
    r'\bsilent reasoning\b',
    r'^reasoning\s*:',
    r'\bthe (task|prompt|instruction)\b',
    r'\bActually\b',
    r"\bwe (must|should|need to) (produce|generate|write|output)\b",
]
_BAD_RE = _re.compile('|'.join(_BAD_PATTERNS), _re.IGNORECASE)


def is_clean_thought(t: str) -> bool:
    if not t:
        return False
    s = t.strip()
    if len(s.split()) < 5:
        return False
    if len(s) > 500:
        return False
    if _BAD_RE.search(s):
        return False
    if s in TRIVIAL_THOUGHTS:
        return False
    return True


def load_thoughts() -> dict[str, str]:
    """Latest CLEAN non-trivial thought per key.

    thoughts.jsonl is append-only across rounds; later entries win provided
    they're clean and non-trivial. still_dirty entries are ignored.
    """
    m: dict[str, str] = {}
    with THOUGHTS.open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("still_dirty"):
                continue
            key = r.get("key")
            t = (r.get("thought") or "").strip()
            if not key or not t:
                continue
            if t in TRIVIAL_THOUGHTS:
                continue
            if not is_clean_thought(t):
                continue
            m[key] = t
    return m


def extract_existing_thought(toon: str) -> str | None:
    """Return the value of the first `thought:` line (quotes stripped)
    or None if no thought line."""
    if not toon:
        return None
    for line in toon.splitlines():
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


def inject_thought(decoder: ToonDecoder, encoder: ToonEncoder, toon: str, thought: str) -> str:
    """Decode TOON, place a `thought` field at the top, re-encode.

    For dicts: prepend the thought (overwriting any existing `thought` key).
    For non-dicts: wrap as {"thought": ..., "value": <original>}.
    """
    safe_thought = thought.replace("\n", " ").strip()
    try:
        obj = decoder.decode(toon)
    except Exception:
        try:
            line = encoder.encode({"thought": safe_thought}).rstrip()
            return line + "\n" + toon
        except Exception:
            return toon
    if isinstance(obj, dict):
        new_obj = {"thought": safe_thought}
        for k, v in obj.items():
            if k == "thought":
                continue
            new_obj[k] = v
    else:
        new_obj = {"thought": safe_thought, "value": obj}
    try:
        return encoder.encode(new_obj)
    except Exception:
        return toon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--input", type=Path, default=TRAIN_IN)
    ap.add_argument("--output", type=Path, default=TRAIN_OUT)
    ap.add_argument("--manifest", type=Path, default=MANIFEST_OUT)
    args = ap.parse_args()

    print(f"[load] {THOUGHTS}", file=sys.stderr)
    thoughts = load_thoughts()
    print(f"[load] {len(thoughts)} clean non-trivial synthesized thoughts",
          file=sys.stderr)

    encoder = ToonEncoder()
    decoder = ToonDecoder()

    stats = {
        "total": 0,
        "matched": 0,
        "injected_empty": 0,
        "replaced_trivial": 0,
        "kept_existing": 0,
        "decode_fail": 0,
        "no_thought_for_key": 0,
        "rejected_dirty": 0,
    }
    start = time.time()

    with args.input.open() as fin, args.output.open("w") as fout:
        for idx, line in enumerate(fin):
            if args.limit and idx >= args.limit:
                break
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line)
                continue
            key = str(idx)
            thought = thoughts.get(key)
            if thought is not None:
                stats["matched"] += 1
                er = rec.get("expectedResponse") or ""
                existing = extract_existing_thought(er)
                if not is_clean_thought(thought):
                    stats["rejected_dirty"] += 1
                elif existing is None or existing == "":
                    new_er = inject_thought(decoder, encoder, er, thought)
                    if new_er != er:
                        rec["expectedResponse"] = new_er
                        stats["injected_empty"] += 1
                    else:
                        stats["decode_fail"] += 1
                elif is_trivial(existing):
                    new_er = inject_thought(decoder, encoder, er, thought)
                    if new_er != er:
                        rec["expectedResponse"] = new_er
                        stats["replaced_trivial"] += 1
                    else:
                        stats["decode_fail"] += 1
                else:
                    stats["kept_existing"] += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 50000 == 0:
                el = time.time() - start
                print(
                    f"[progress] {stats['total']} lines  "
                    f"injected={stats['injected_empty']} "
                    f"replaced={stats['replaced_trivial']} "
                    f"matched={stats['matched']} "
                    f"elapsed={el:.0f}s",
                    file=sys.stderr,
                )

    encoder.close()
    decoder.close()

    elapsed = time.time() - start
    manifest = {
        "input": str(args.input),
        "output": str(args.output),
        "thoughts_source": str(THOUGHTS),
        "stats": stats,
        "elapsed_sec": elapsed,
    }
    args.manifest.write_text(json.dumps(manifest, indent=2))
    print("\n=== DONE ===", file=sys.stderr)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    print(f"wrote {args.output} ({elapsed:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
