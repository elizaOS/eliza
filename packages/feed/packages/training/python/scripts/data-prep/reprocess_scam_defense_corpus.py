#!/usr/bin/env python3
"""
Reprocess canonical scam-defense training examples into exchange formats.

Input:
- a directory containing training_examples.jsonl
- or a direct path to training_examples.jsonl

Output:
- canonical.jsonl-like rows
- OpenAI chat rows
- Anthropic message rows
- Hermes / ElizaOS / OpenClaw bridge rows
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from scam_defense_exchange import load_training_example_rows, write_reprocessed_formats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reprocess canonical scam-defense rows into exchange formats."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Directory containing training_examples.jsonl, or the JSONL file itself.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write the reprocessed formats into.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    rows = load_training_example_rows(input_path)
    counts = write_reprocessed_formats(
        training_rows=rows,
        output_dir=output_dir,
    )

    print(f"Loaded {len(rows)} canonical rows from {input_path}")
    print(f"Wrote formats into {output_dir}")
    for name, count in sorted(counts.items()):
        print(f"  {name}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
