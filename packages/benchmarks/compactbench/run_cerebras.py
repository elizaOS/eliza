#!/usr/bin/env python3
"""
Programmatic CompactBench runner with the Cerebras provider pre-registered.

The published compactbench v0.1.0 doesn't ship a Cerebras provider and
doesn't expose a plugin entry point, so the `compactbench run` CLI alone
cannot route to Cerebras. This script wires the Cerebras provider into
the in-process registry and then invokes the same `run_experiment` /
`render_summary` paths the CLI uses.

Usage (from packages/benchmarks/compactbench/):
    python run_cerebras.py \
        --method ./eliza_compactbench/compactors/__init__.py:NaiveSummaryCompactor \
        --suite starter \
        --benchmarks-dir external/compactbench-suites/benchmarks/public \
        --output results-cerebras-naive.jsonl

Env required:
    CEREBRAS_API_KEY    Cerebras API key.

Optional:
    --model MODEL       defaults to gpt-oss-120b
    --case-count N      defaults to 3
    --drift-cycles N    defaults to 2
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from eliza_compactbench.cerebras_provider import register_cerebras_provider


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--method", required=True)
    parser.add_argument("--suite", default="starter")
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument(
        "--benchmarks-dir",
        default="external/compactbench-suites/benchmarks/public",
        type=Path,
    )
    parser.add_argument("--output", default="results-cerebras.jsonl", type=Path)
    parser.add_argument("--case-count", type=int, default=3)
    parser.add_argument("--drift-cycles", type=int, default=2)
    parser.add_argument("--difficulty", default="medium")
    parser.add_argument("--seed-group", default="default")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--score",
        action="store_true",
        help="Print a score summary after the run completes.",
    )
    args = parser.parse_args()

    if not os.environ.get("CEREBRAS_API_KEY"):
        print("error: CEREBRAS_API_KEY is required", file=sys.stderr)
        return 2

    if not register_cerebras_provider():
        print("error: failed to register cerebras provider", file=sys.stderr)
        return 2

    from compactbench.dsl import DifficultyLevel
    from compactbench.runner import RunArgs, RunnerError, run_experiment

    try:
        difficulty = DifficultyLevel(args.difficulty.lower())
    except ValueError:
        print(f"error: unknown difficulty {args.difficulty!r}", file=sys.stderr)
        return 2

    run_args = RunArgs(
        method_spec=args.method,
        suite_key=args.suite,
        provider_key="cerebras",
        model=args.model,
        difficulty=difficulty,
        drift_cycles=args.drift_cycles,
        case_count_per_template=args.case_count,
        seed_group=args.seed_group,
        benchmarks_dir=args.benchmarks_dir,
        output_path=args.output,
        resume=args.resume,
    )
    try:
        asyncio.run(run_experiment(run_args))
    except RunnerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"wrote {args.output}")

    if args.score:
        # Mirror `compactbench score` behavior using its public surface.
        from compactbench.cli import score as score_cmd

        score_cmd(results=args.output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
