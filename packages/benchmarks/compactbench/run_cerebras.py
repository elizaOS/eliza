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

ROOT = Path(__file__).resolve().parent
EXTERNAL_SRC = ROOT / "external" / "compactbench-suites" / "src"
if EXTERNAL_SRC.exists():
    sys.path.insert(0, str(EXTERNAL_SRC))

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
    parser.add_argument(
        "--analyze-valid-hits",
        action="store_true",
        help=(
            "Rerun the same cases and write response-level repaired "
            "benchmark analysis."
        ),
    )
    parser.add_argument(
        "--valid-hit-output",
        type=Path,
        default=None,
        help="Output JSONL for --analyze-valid-hits. Defaults beside --output.",
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

    # Refuse to silently overwrite a half-written file from a previous
    # crash. A real run always ends with a `run_end` event, so any file
    # missing one is suspect. --resume is the only path that should
    # touch an existing output.
    if (
        not args.resume
        and args.output.exists()
        and args.output.stat().st_size > 0
        and not _looks_complete(args.output)
    ):
        print(
            f"error: {args.output} exists and looks incomplete (no run_end event). "
            "Pass --resume to continue, or remove the file to overwrite.",
            file=sys.stderr,
        )
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
    except KeyboardInterrupt:
        # asyncio.run cancels the task and propagates KeyboardInterrupt
        # after the runner's `finally` has flushed and closed the writer.
        # Tell the user the file is recoverable via --resume.
        print(
            f"\ninterrupted; partial results written to {args.output}. "
            "Re-run with --resume to continue.",
            file=sys.stderr,
        )
        return 130

    print(f"wrote {args.output}")

    if args.score:
        # Mirror `compactbench score` behavior using its public surface.
        from compactbench.cli import score as score_cmd

        try:
            score_cmd(results=args.output)
        except SystemExit as exc:
            # typer.Exit subclasses SystemExit; let a successful score
            # (code 0) fall through, surface failures to the caller.
            code = exc.code if isinstance(exc.code, int) else 1
            return code

    if args.analyze_valid_hits:
        from argparse import Namespace

        from analyze_valid_hits import _run_analysis

        valid_hit_output = args.valid_hit_output
        if valid_hit_output is None:
            valid_hit_output = args.output.with_name(
                f"{args.output.stem}.valid-hits.jsonl"
            )
        analysis_args = Namespace(
            method=args.method,
            suite=args.suite,
            model=args.model,
            benchmarks_dir=args.benchmarks_dir,
            output=valid_hit_output,
            case_count=args.case_count,
            drift_cycles=args.drift_cycles,
            difficulty=args.difficulty,
            seed_group=args.seed_group,
            provider="cerebras",
            template_key=None,
            seed_slot=None,
        )
        summary = asyncio.run(_run_analysis(analysis_args))
        print("repaired benchmark analysis:")
        print(
            f"  overall_score={summary['overall_score']:.3f} "
            f"benchmark_quality_score={summary['benchmark_quality_score']:.3f} "
            f"raw_lexical_overall_score={summary['raw_lexical_overall_score']:.3f} "
            f"valid_false_negatives={summary['valid_false_negatives']} "
            f"semantic_false_positives={summary['semantic_false_positives']}"
        )
        print(
            f"  failures_remaining={summary['failures_remaining']} "
            f"repaired_expected_conflicts={summary['repaired_expected_conflicts']} "
            f"removed_invalid_items={summary['removed_invalid_items']} "
            f"judge_refusals={summary['judge_refusals']}"
        )
        print(f"  wrote {valid_hit_output}")

    return 0


def _looks_complete(path: Path) -> bool:
    """Return True if the last line of the JSONL file is a ``run_end`` event.

    A clean run always closes with ``{"event":"run_end",...}``. Anything
    else means the runner crashed or was killed mid-write.
    """
    try:
        # Read the tail of the file; we only need the last line.
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            chunk = 4096
            fh.seek(max(0, size - chunk))
            tail = fh.read().decode("utf-8", errors="replace")
        last = tail.strip().splitlines()[-1] if tail.strip() else ""
        return '"event": "run_end"' in last or '"event":"run_end"' in last
    except OSError:
        return False


if __name__ == "__main__":
    sys.exit(main())
