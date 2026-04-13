#!/usr/bin/env python3
"""
Terminal-Bench Benchmark Runner Script

This script runs the Terminal-Bench benchmark with configurable options.

Usage:
    python scripts/run_benchmark.py [--sample] [--max-tasks N] [--model MODEL]

Examples:
    # Run with sample tasks (quick test)
    python scripts/run_benchmark.py --sample

    # Run full benchmark with GPT-4
    python scripts/run_benchmark.py --model gpt-4

    # Run limited tasks
    python scripts/run_benchmark.py --max-tasks 10
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

# Add parent directory to path for local development
sys.path.insert(0, str(Path(__file__).parent.parent))

from elizaos_terminal_bench import (
    TerminalBenchRunner,
    TerminalBenchConfig,
    TaskCategory,
)


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.INFO if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )


async def run_benchmark(
    sample: bool = False,
    max_tasks: int | None = None,
    filter_tasks: str | None = None,
    model: str = "gpt-4",
    verbose: bool = True,
) -> None:
    """Run the Terminal-Bench benchmark."""
    setup_logging(verbose)

    # Check for API key
    has_api_key = os.getenv("OPENAI_API_KEY") or os.getenv("GROQ_API_KEY") or os.getenv("OPENROUTER_API_KEY")
    if not has_api_key:
        print("Warning: No API key set (OPENAI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY).")
        print("The benchmark will fail without one.")
        if not sample:
            return

    # Use local data directory if it exists
    script_dir = Path(__file__).parent.parent
    local_data_dir = script_dir / "data"
    data_path = str(local_data_dir) if local_data_dir.exists() else None

    # Parse filter
    task_ids = None
    if filter_tasks:
        task_ids = [t.strip() for t in filter_tasks.split(",") if t.strip()]

    config = TerminalBenchConfig(
        output_dir="./benchmark_results/terminal-bench",
        max_tasks=max_tasks,
        task_ids=task_ids,
        max_iterations=20,
        timeout_per_task_seconds=300,
        model_name=model,
        temperature=0.0,
        verbose=verbose,
        compare_leaderboard=True,
        data_path=data_path,
    )

    runner = TerminalBenchRunner(config=config)
    await runner.setup(use_sample_tasks=sample)

    print(f"\n{'='*60}")
    print("TERMINAL-BENCH BENCHMARK")
    print(f"{'='*60}")
    print(f"Tasks: {len(runner.dataset)} tasks loaded")
    print(f"Model: {model}")
    print(f"Max iterations: {config.max_iterations}")
    print(f"Timeout: {config.timeout_per_task_seconds}s per task")
    print(f"{'='*60}\n")

    report = await runner.run()

    # Print summary
    print(f"\n{'='*60}")
    print("RESULTS")
    print(f"{'='*60}")
    print(f"Accuracy: {report.accuracy:.1%}")
    print(f"Passed: {report.passed_tasks}/{report.total_tasks}")
    print(f"Total Commands: {report.total_commands}")
    print(f"Total Tokens: {report.total_tokens:,}")
    print(f"Evaluation Time: {report.evaluation_time_seconds:.1f}s")

    if report.leaderboard_comparison:
        lc = report.leaderboard_comparison
        print(f"\nLeaderboard Rank: #{lc.rank} out of {lc.total_entries}")
        print(f"Score: {lc.our_score:.1f}%")
        print(f"Percentile: {lc.percentile:.1f}%")

        if lc.nearest_above:
            print(f"Nearest above: {lc.nearest_above[0]} ({lc.nearest_above[1]:.1f}%)")
        if lc.nearest_below:
            print(f"Nearest below: {lc.nearest_below[0]} ({lc.nearest_below[1]:.1f}%)")

    print(f"\nResults saved to: {config.output_dir}")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Run Terminal-Bench benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--sample",
        action="store_true",
        help="Use sample tasks for quick testing",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum number of tasks to run",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4",
        help="Model to use (default: gpt-4)",
    )
    parser.add_argument(
        "--filter",
        type=str,
        default=None,
        help="Comma-separated list of task IDs to run (e.g., compile_003,text_001)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        default=True,
        help="Enable verbose output",
    )
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Disable verbose output",
    )

    args = parser.parse_args()

    verbose = args.verbose and not args.quiet

    try:
        asyncio.run(run_benchmark(
            sample=args.sample,
            max_tasks=args.max_tasks,
            filter_tasks=args.filter,
            model=args.model,
            verbose=verbose,
        ))
    except KeyboardInterrupt:
        print("\nBenchmark interrupted")
        sys.exit(130)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
