"""Split train_v2.jsonl into train/val/test for the HF publish pipeline.

publish_dataset_to_hf.py expects train.jsonl + val.jsonl + test.jsonl
under data/final. build_v2_corpus.py only produces a single
train_v2.jsonl, so this script does a deterministic random split:

    train_v2.jsonl  →  train.jsonl  (95 %)
                       val.jsonl    ( 4 %)
                       test.jsonl   ( 1 %)

Stratifies on metadata.split when present (records pre-marked val/test
go to their assigned split). Records without a split marker are diced.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("split-v2")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path,
                    default=Path("data/final/train_v2.jsonl"))
    ap.add_argument("--out-dir", type=Path,
                    default=Path("data/final"))
    ap.add_argument("--val-frac", type=float, default=0.04)
    ap.add_argument("--test-frac", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=0xDEADBEEF)
    args = ap.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2

    rng = random.Random(args.seed)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    train_p = args.out_dir / "train.jsonl"
    val_p = args.out_dir / "val.jsonl"
    test_p = args.out_dir / "test.jsonl"

    n_train = n_val = n_test = n_total = 0
    val_threshold = args.val_frac
    test_threshold = args.val_frac + args.test_frac

    with args.input.open("r", encoding="utf-8") as fin, \
         train_p.open("w", encoding="utf-8") as ftr, \
         val_p.open("w", encoding="utf-8") as fv, \
         test_p.open("w", encoding="utf-8") as fte:
        for line in fin:
            line = line.rstrip("\n")
            if not line:
                continue
            n_total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = rec.get("metadata") or {}
            sp = (md.get("split") or "").lower()
            if sp in ("val", "validation", "dev"):
                fv.write(line + "\n")
                n_val += 1
                continue
            if sp == "test":
                fte.write(line + "\n")
                n_test += 1
                continue
            r = rng.random()
            if r < val_threshold:
                fv.write(line + "\n")
                n_val += 1
            elif r < test_threshold:
                fte.write(line + "\n")
                n_test += 1
            else:
                ftr.write(line + "\n")
                n_train += 1
            if n_total % 100_000 == 0:
                log.info("scanned %d records (train=%d val=%d test=%d)",
                         n_total, n_train, n_val, n_test)

    log.info("done: total=%d train=%d val=%d test=%d",
             n_total, n_train, n_val, n_test)
    log.info("  → %s", train_p)
    log.info("  → %s", val_p)
    log.info("  → %s", test_p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
