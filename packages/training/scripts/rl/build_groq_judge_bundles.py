#!/usr/bin/env python3
"""
Build offline Groq judge bundles for canonical scam-defense corpora or RLVR best CoTs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from scam_defense_exchange import (
    canonical_record_from_row,
    load_training_example_rows,
    write_reprocessed_formats,
)

from src.training.groq_judge_bundles import (
    GROQ_BASE_URL,
    attach_bundles_to_best_cots,
    attach_bundles_to_training_rows,
    best_cot_to_candidate,
    canonical_record_to_candidate,
    load_jsonl_dicts,
    score_candidates,
    write_jsonl,
)


def judge_training_rows(
    *,
    input_path: Path,
    output_dir: Path,
    model: str,
    mode: str,
    base_url: str,
) -> dict[str, object]:
    training_rows = load_training_example_rows(input_path)
    canonical_records = [canonical_record_from_row(row) for row in training_rows]
    candidates = [canonical_record_to_candidate(record) for record in canonical_records]
    bundles = score_candidates(
        candidates=candidates,
        model=model,
        mode=mode,
        base_url=base_url,
    )
    attached_rows = attach_bundles_to_training_rows(training_rows, bundles)
    attached_dir = output_dir / "attached-corpus"
    write_jsonl(attached_dir / "training_examples.jsonl", attached_rows)
    write_reprocessed_formats(
        training_rows=attached_rows,
        output_dir=attached_dir / "formats",
    )
    return {
        "bundles": bundles,
        "summary": {
            "inputType": "training-rows",
            "input": str(input_path),
            "attachedCorpus": str(attached_dir / "training_examples.jsonl"),
            "bundleCount": len(bundles),
        },
    }


def judge_best_cots(
    *,
    input_path: Path,
    output_dir: Path,
    model: str,
    mode: str,
    base_url: str,
) -> dict[str, object]:
    best_cots = load_jsonl_dicts(input_path)
    candidates = [
        candidate
        for candidate in (best_cot_to_candidate(row) for row in best_cots)
        if candidate is not None
    ]
    bundles = score_candidates(
        candidates=candidates,
        model=model,
        mode=mode,
        base_url=base_url,
    )
    attached_cots = attach_bundles_to_best_cots(best_cots, bundles)
    attached_path = output_dir / "best_cots.judged.jsonl"
    write_jsonl(attached_path, attached_cots)
    return {
        "bundles": bundles,
        "summary": {
            "inputType": "best-cots",
            "input": str(input_path),
            "attachedBestCots": str(attached_path),
            "bundleCount": len(bundles),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build Groq judge bundles for scam-defense corpora or RLVR best CoTs."
    )
    parser.add_argument("--input", required=True, help="Input directory or JSONL file.")
    parser.add_argument(
        "--input-type",
        choices=["training-rows", "best-cots"],
        default="training-rows",
        help="Shape of the input file.",
    )
    parser.add_argument("--output-dir", required=True, help="Directory for judge artifacts.")
    parser.add_argument("--model", required=True, help="Groq model id for judging.")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("GROQ_BASE_URL", GROQ_BASE_URL),
        help="OpenAI-compatible base URL for the judge backend.",
    )
    parser.add_argument(
        "--mode",
        choices=["single", "relative"],
        default="single",
        help="Judge candidates independently or relatively by scenario/group.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.input_type == "training-rows":
        result = judge_training_rows(
            input_path=input_path,
            output_dir=output_dir,
            model=args.model,
            mode=args.mode,
            base_url=args.base_url,
        )
    else:
        result = judge_best_cots(
            input_path=input_path,
            output_dir=output_dir,
            model=args.model,
            mode=args.mode,
            base_url=args.base_url,
        )

    bundles = list(result["bundles"])
    summary = dict(result["summary"])

    bundles_path = output_dir / "judge_bundles.jsonl"
    write_jsonl(bundles_path, bundles)
    summary["bundlesPath"] = str(bundles_path)
    summary["judgeModel"] = args.model
    summary["mode"] = args.mode
    summary["baseUrl"] = args.base_url

    (output_dir / "manifest.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
