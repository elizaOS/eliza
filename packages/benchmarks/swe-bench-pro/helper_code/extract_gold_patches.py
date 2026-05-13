#!/usr/bin/env python3
"""
Extract gold patches from the HuggingFace SWE-bench Pro dataset.

This script downloads the SWE-bench Pro dataset and extracts the gold (reference)
patches into a JSON file format suitable for evaluation.

Usage:
    python helper_code/extract_gold_patches.py --output gold_patches.json

The output JSON file has the format:
[
    {
        "instance_id": "instance_...",
        "patch": "diff --git ...",
        "prefix": "gold"
    },
    ...
]
"""

import argparse
import json
from datasets import load_dataset


def main():
    parser = argparse.ArgumentParser(
        description="Extract gold patches from HuggingFace SWE-bench Pro dataset"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="gold_patches.json",
        help="Output JSON file path (default: gold_patches.json)"
    )
    parser.add_argument(
        "--prefix",
        type=str,
        default="gold",
        help="Prefix to use for the patches (default: gold)"
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default="ScaleAI/SWE-bench_Pro",
        help="HuggingFace dataset name (default: ScaleAI/SWE-bench_Pro)"
    )
    parser.add_argument(
        "--split",
        type=str,
        default="test",
        help="Dataset split to use (default: test)"
    )
    args = parser.parse_args()

    print(f"Loading dataset: {args.dataset} (split: {args.split})")
    dataset = load_dataset(args.dataset, split=args.split)

    patches = []
    skipped = 0

    for row in dataset:
        instance_id = row["instance_id"]
        patch = row.get("patch") or row.get("gold_patch") or row.get("model_patch")

        if not patch:
            print(f"  Warning: No patch found for {instance_id}, skipping")
            skipped += 1
            continue

        patches.append({
            "instance_id": instance_id,
            "patch": patch,
            "prefix": args.prefix
        })

    print(f"\nExtracted {len(patches)} patches ({skipped} skipped)")

    with open(args.output, "w") as f:
        json.dump(patches, f, indent=2)

    print(f"Saved to: {args.output}")


if __name__ == "__main__":
    main()
