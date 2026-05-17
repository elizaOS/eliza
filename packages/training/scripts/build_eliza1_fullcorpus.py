"""Build the eliza-1-0_8b full-corpus SFT splits.

Concatenates the benchmark-aligned `datasets/eliza1-sft-0_8b/{train,val,test}.jsonl`
splits AHEAD of the broad mixed `data/final/{train,val,test}.jsonl` corpus,
running every row through `format_for_training.format_record` so only
train_local-compatible records land in the output. The benchmark-aligned rows go
first so that, with a cosine LR warmup, the early steps see the structured
ACTION/tool-call/personality rows the publish gates measure.

The benchmark-aligned slice is ~49x smaller than the broad `data/final` mix, so
the structured-output rows the publish gates score (response envelope,
ACTION/tool-call, personality, voice-emotion) are heavily diluted. Set
`ELIZA1_FULLCORPUS_UPSAMPLE=N` to repeat that slice N times in the *train* split
only (val/test are never upsampled). Default 1 (no upsample).

Output: `data/final-eliza1-fullcorpus/{train,val,test}.jsonl` (gitignored;
the run report records the row counts + sha256s).

Usage:
    uv run python scripts/build_eliza1_fullcorpus.py
    ELIZA1_FULLCORPUS_UPSAMPLE=8 uv run python scripts/build_eliza1_fullcorpus.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402

SRC_BENCH = ROOT / "datasets" / "eliza1-sft-0_8b"
SRC_FINAL = ROOT / "data" / "final"
OUT_DIR = ROOT / "data" / "final-eliza1-fullcorpus"

UPSAMPLE = max(1, int(os.environ.get("ELIZA1_FULLCORPUS_UPSAMPLE", "1")))


def _load_valid(src: Path) -> list[str]:
    rows: list[str] = []
    with src.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if format_record(rec) is None:
                continue
            rows.append(json.dumps(rec, ensure_ascii=False))
    return rows


def _concat(out_path: Path, sources: list[tuple[Path, int]]) -> int:
    n_ok = 0
    with out_path.open("w", encoding="utf-8") as out:
        for src, repeat in sources:
            rows = _load_valid(src)
            for _ in range(repeat):
                for r in rows:
                    out.write(r + "\n")
                n_ok += len(rows)
    return n_ok


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for split in ("train", "val", "test"):
        bench_repeat = UPSAMPLE if split == "train" else 1
        n_ok = _concat(
            OUT_DIR / f"{split}.jsonl",
            [(SRC_BENCH / f"{split}.jsonl", bench_repeat), (SRC_FINAL / f"{split}.jsonl", 1)],
        )
        suffix = f" (eliza1-sft slice x{bench_repeat})" if bench_repeat > 1 else ""
        print(f"{split}: {n_ok} format_record-valid rows{suffix} -> {OUT_DIR / f'{split}.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
