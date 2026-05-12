"""Build the eliza-1-0_6b full-corpus SFT splits.

Concatenates the benchmark-aligned `datasets/eliza1-sft-0_6b/{train,val,test}.jsonl`
splits AHEAD of the broad mixed `data/final/{train,val,test}.jsonl` corpus,
running every row through `format_for_training.format_record` so only
train_local-compatible records land in the output. The benchmark-aligned rows go
first so that, with a cosine LR warmup, the early steps see the structured
ACTION/tool-call/personality rows the publish gates measure.

Output: `data/final-eliza1-fullcorpus/{train,val,test}.jsonl` (gitignored;
the run report records the row counts + sha256s).

Usage:
    uv run python scripts/build_eliza1_fullcorpus.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402

SRC_BENCH = ROOT / "datasets" / "eliza1-sft-0_6b"
SRC_FINAL = ROOT / "data" / "final"
OUT_DIR = ROOT / "data" / "final-eliza1-fullcorpus"


def _concat(out_path: Path, sources: list[Path]) -> tuple[int, int]:
    n_in = n_ok = 0
    with out_path.open("w", encoding="utf-8") as out:
        for src in sources:
            with src.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    n_in += 1
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if format_record(rec) is None:
                        continue
                    n_ok += 1
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return n_in, n_ok


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for split in ("train", "val", "test"):
        n_in, n_ok = _concat(
            OUT_DIR / f"{split}.jsonl",
            [SRC_BENCH / f"{split}.jsonl", SRC_FINAL / f"{split}.jsonl"],
        )
        print(f"{split}: {n_in} read, {n_ok} format_record-valid → {OUT_DIR / f'{split}.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
