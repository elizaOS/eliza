#!/usr/bin/env python3
"""Merge multiple LJSpeech-format corpus directories into a single training run dir.

Inputs: one or more dirs, each with train_list.txt + val_list.txt + wavs_norm/
Output: merged dir with combined train_list.txt + val_list.txt + wavs_norm/ (symlinks)

Usage:
    python3 merge_corpus.py \\
        --input /tmp/corpus-augmented \\
        --input /tmp/corpus-distilled \\
        --out /tmp/corpus-merged
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.merge_corpus")


def merge_corpora(inputs: list[Path], out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(exist_ok=True)

    train_lines: list[str] = []
    val_lines: list[str] = []
    total_clips = 0

    for src in inputs:
        train_file = src / "train_list.txt"
        val_file = src / "val_list.txt"
        wavs_src = src / "wavs_norm"

        if not train_file.exists():
            log.warning("no train_list.txt in %s, skipping", src)
            continue

        # Symlink wavs
        if wavs_src.exists():
            for wav in wavs_src.glob("*.wav"):
                link = wavs_out / wav.name
                if not link.exists():
                    os.symlink(str(wav.resolve()), str(link))

        for line in train_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                train_lines.append(line)
                total_clips += 1

        if val_file.exists():
            for line in val_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    val_lines.append(line)

    (out_dir / "train_list.txt").write_text("\n".join(train_lines) + "\n", encoding="utf-8")
    (out_dir / "val_list.txt").write_text("\n".join(val_lines) + "\n", encoding="utf-8")

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputs": [str(p) for p in inputs],
        "trainLines": len(train_lines),
        "valLines": len(val_lines),
        "totalClips": total_clips,
        "outDir": str(out_dir),
    }
    (out_dir / "merge_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    log.info(
        "merged %d inputs → %d train + %d val clips in %s",
        len(inputs),
        len(train_lines),
        len(val_lines),
        out_dir,
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, action="append", dest="inputs", required=True)
    p.add_argument("--out", type=Path, required=True)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = merge_corpora(args.inputs, args.out)
    log.info("done: %s", json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
