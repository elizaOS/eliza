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
- rlm: Direct RLM plugin inference (bypasses Eliza runtime)
- eliza: Full Eliza agent loop (Provider -> Model -> Action -> Evaluator)
- custom: Custom LLM query function

Example:
    python run_benchmark.py --mode stub --context-lengths 1000,10000
    python run_benchmark.py --mode rlm --backend gemini
    python run_benchmark.py --mode eliza --context-lengths 1000,10000
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Callable

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


def _load_env_file(env_path: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    - Only sets keys that are not already present in os.environ.
    - Ignores blank lines and comments.
    """
    if not env_path.exists():
        return

    try:
        content = env_path.read_text(encoding="utf-8")
    except Exception:
        return

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = value


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run RLM Benchmark Suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Quick stub test
  python run_benchmark.py --mode stub --context-lengths 1000,10000

  # Full RLM benchmark (direct client, bypasses Eliza)
  python run_benchmark.py --mode rlm --backend gemini

  # Full Eliza agent loop (uses runtime + RLM plugin)
  python run_benchmark.py --mode eliza --context-lengths 1000,10000

  # Custom context lengths
  python run_benchmark.py --context-lengths 1000,10000,100000,1000000
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["stub", "rlm", "eliza", "custom"],
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


async def run_eliza_benchmark_mode(
    config: RLMBenchConfig,
    progress_callback_fn: Callable[[int, int], None],
    output_dir: str,
) -> int:
    """Run the full Eliza agent loop benchmark.

    This mode exercises the complete canonical Eliza flow:
    1. RLM_CONTEXT provider injects benchmark context
    2. MESSAGE_HANDLER_TEMPLATE generates response with actions
    3. REPLY action (from bootstrap) processes the response
    4. RLM_BENCH_EVALUATOR assesses accuracy

    Args:
        config: Benchmark configuration.
        progress_callback_fn: Progress callback.
        output_dir: Output directory for results.

    Returns:
        Exit code.

    """
    from elizaos_rlm_bench.runner import run_eliza_benchmark

    print("Running FULL Eliza Agent Loop benchmark...")
    print("This tests the complete canonical flow:")
    print("  RLM_CONTEXT Provider -> MESSAGE_HANDLER -> REPLY Action -> Evaluator")
    print()

    results = await run_eliza_benchmark(
        config=config,
        progress_callback=progress_callback_fn,
    )

    print()  # Newline after progress bar

    # Save results
    output_path = save_results(results, output_dir)

    # Print summary
    print("\n" + "=" * 60)
    print("ELIZA AGENT LOOP BENCHMARK COMPLETE")
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

    print("\nBenchmark Mode: Full Eliza Agent Loop")
    print("  Tested: Provider -> Model (RLM) -> Action (REPLY) -> Evaluator")
    print(f"\nResults saved to: {output_path}")
    print("=" * 60)

    return 0


async def main() -> int:
    """Main entry point."""
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Load repo-root .env if present (for real providers / API keys)
    repo_root = Path(__file__).resolve().parents[2]
    _load_env_file(repo_root / ".env")

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

    # Special handling for eliza mode (FULL canonical agent loop)
    if args.mode == "eliza":
        return await run_eliza_benchmark_mode(
            config=config,
            progress_callback_fn=progress_callback,
            output_dir=args.output_dir,
        )

    # Create runner and execute (stub, rlm, custom modes)
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
