#!/usr/bin/env python3
"""
Run the RLM Benchmark suite.

This script evaluates RLM (Recursive Language Model) performance on long-context
tasks as described in arXiv:2512.24601.

Benchmarks:
- S-NIAH: Streaming Needle-in-a-Haystack (Table 1)
- OOLONG: Long document retrieval and reasoning (Table 2)
- Strategy Analysis: Emergent RLM patterns (Section 4.1)

Modes:
- stub: Fast testing with heuristic-based mock
- rlm: Full RLM plugin inference
- custom: Custom LLM query function

Example:
    python run_benchmark.py --mode stub --context-lengths 1000,10000
    python run_benchmark.py --mode rlm --backend gemini
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from elizaos_rlm_bench import (
    RLMBenchConfig,
    RLMBenchRunner,
    save_results,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("rlm-bench")


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run RLM Benchmark Suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Quick stub test
  python run_benchmark.py --mode stub --context-lengths 1000,10000

  # Full RLM benchmark
  python run_benchmark.py --mode rlm --backend gemini

  # Custom context lengths
  python run_benchmark.py --context-lengths 1000,10000,100000,1000000
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["stub", "rlm", "custom"],
        default="stub",
        help="Execution mode (default: stub)",
    )

    parser.add_argument(
        "--backend",
        default="gemini",
        help="RLM backend (default: gemini)",
    )

    parser.add_argument(
        "--context-lengths",
        default="1000,10000,100000",
        help="Comma-separated context lengths in tokens (default: 1000,10000,100000)",
    )

    parser.add_argument(
        "--tasks-per-config",
        type=int,
        default=3,
        help="Number of tasks per configuration (default: 3)",
    )

    parser.add_argument(
        "--output-dir",
        default="./benchmark_results/rlm-bench",
        help="Output directory for results",
    )

    parser.add_argument(
        "--no-s-niah",
        action="store_true",
        help="Skip S-NIAH benchmark",
    )

    parser.add_argument(
        "--no-oolong",
        action="store_true",
        help="Skip OOLONG benchmark",
    )

    parser.add_argument(
        "--dual-model",
        action="store_true",
        help="Use dual-model configuration (Paper Section 3.2)",
    )

    parser.add_argument(
        "--root-model",
        default="gemini-2.0-flash",
        help="Root model for dual-model config",
    )

    parser.add_argument(
        "--subcall-model",
        default="gemini-2.0-flash",
        help="Sub-call model for dual-model config",
    )

    parser.add_argument(
        "--max-iterations",
        type=int,
        default=50,
        help="Maximum RLM iterations (default: 50)",
    )

    parser.add_argument(
        "--max-depth",
        type=int,
        default=5,
        help="Maximum RLM recursion depth (default: 5)",
    )

    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


def progress_callback(current: int, total: int) -> None:
    """Print progress update."""
    pct = (current / total) * 100
    bar_len = 30
    filled = int(bar_len * current / total)
    bar = "=" * filled + "-" * (bar_len - filled)
    print(f"\r[{bar}] {current}/{total} ({pct:.1f}%)", end="", flush=True)


async def main() -> int:
    """Main entry point."""
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Parse context lengths
    context_lengths = [int(x.strip()) for x in args.context_lengths.split(",")]

    # Build configuration
    config = RLMBenchConfig(
        output_dir=args.output_dir,
        context_lengths=context_lengths,
        max_context_length=max(context_lengths),
        tasks_per_config=args.tasks_per_config,
        run_s_niah=not args.no_s_niah,
        run_s_niah_multi=not args.no_s_niah,
        run_oolong=not args.no_oolong,
        run_oolong_pairs=not args.no_oolong,
        rlm_backend=args.backend,
        rlm_max_iterations=args.max_iterations,
        rlm_max_depth=args.max_depth,
        use_dual_model=args.dual_model,
        root_model=args.root_model,
        subcall_model=args.subcall_model,
    )

    logger.info("=" * 60)
    logger.info("RLM Benchmark Suite")
    logger.info("=" * 60)
    logger.info(f"Mode: {args.mode}")
    logger.info(f"Backend: {args.backend}")
    logger.info(f"Context lengths: {context_lengths}")
    logger.info(f"Tasks per config: {args.tasks_per_config}")
    logger.info(f"S-NIAH: {'enabled' if not args.no_s_niah else 'disabled'}")
    logger.info(f"OOLONG: {'enabled' if not args.no_oolong else 'disabled'}")
    if args.dual_model:
        logger.info(f"Dual-model: root={args.root_model}, subcall={args.subcall_model}")
    logger.info("=" * 60)

    # Create runner and execute
    runner = RLMBenchRunner(config)

    print("\nRunning benchmark tasks...")
    results = await runner.run_all(mode=args.mode, progress_callback=progress_callback)
    print()  # Newline after progress bar

    # Save results
    output_path = save_results(results, args.output_dir)

    # Print summary
    print("\n" + "=" * 60)
    print("BENCHMARK COMPLETE")
    print("=" * 60)
    print(f"\nOverall Accuracy: {results.metrics.overall_accuracy:.1%}")
    print(f"Tasks: {results.metrics.passed_tasks}/{results.metrics.total_tasks}")
    print(f"Total Cost: ${results.metrics.total_cost_usd:.4f}")
    print(f"Avg Latency: {results.metrics.avg_latency_ms:.1f}ms")

    if results.metrics.s_niah_by_length:
        print("\nS-NIAH by Length:")
        for length, acc in sorted(results.metrics.s_niah_by_length.items()):
            print(f"  {length}: {acc:.1%}")

    if results.metrics.oolong_accuracy > 0:
        print(f"\nOOLONG: {results.metrics.oolong_accuracy:.1%}")
        print(f"OOLONG-Pairs: {results.metrics.oolong_pairs_accuracy:.1%}")

    if results.metrics.most_common_strategies:
        strategies = [s.value for s in results.metrics.most_common_strategies[:3]]
        print(f"\nTop Strategies: {', '.join(strategies)}")

    print(f"\nResults saved to: {output_path}")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
