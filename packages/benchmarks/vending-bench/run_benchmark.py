#!/usr/bin/env python3
"""
Run the Vending-Bench benchmark and generate results.

This script runs the benchmark with the heuristic agent and generates
a comprehensive report comparing results with the leaderboard.
"""

import asyncio
import logging
import sys
from decimal import Decimal
from pathlib import Path

# Add the package to path for direct execution
sys.path.insert(0, str(Path(__file__).parent))

from elizaos_vending_bench.runner import VendingBenchRunner
from elizaos_vending_bench.types import VendingBenchConfig


def setup_logging() -> None:
    """Configure logging."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


async def main() -> int:
    """Run the benchmark."""
    setup_logging()
    logger = logging.getLogger(__name__)

    # Configure benchmark
    config = VendingBenchConfig(
        num_runs=10,  # 10 simulation runs for statistical significance
        max_days_per_run=30,  # Full 30-day simulation
        initial_cash=Decimal("500.00"),
        random_seed=42,  # Fixed seed for reproducibility
        model_name="heuristic",
        temperature=0.0,
        output_dir="./benchmark_results/vending-bench",
        save_detailed_logs=True,
        save_trajectories=True,
        generate_report=True,
        compare_leaderboard=True,
    )

    # Create and run benchmark
    runner = VendingBenchRunner(config)

    logger.info("=" * 70)
    logger.info("Starting Vending-Bench Evaluation for ElizaOS")
    logger.info("=" * 70)
    logger.info("Configuration:")
    logger.info(f"  - Runs: {config.num_runs}")
    logger.info(f"  - Days per run: {config.max_days_per_run}")
    logger.info(f"  - Initial cash: ${config.initial_cash}")
    logger.info(f"  - Model: {config.model_name}")
    logger.info(f"  - Seed: {config.random_seed}")
    logger.info("=" * 70)

    report = await runner.run_benchmark()

    # Print summary
    print("\n" + "=" * 70)
    print("VENDING-BENCH RESULTS")
    print("=" * 70)
    print("\n📊 PERFORMANCE SUMMARY")
    print(f"   Best Net Worth:     ${report.metrics.max_net_worth:.2f}")
    print(f"   Average Net Worth:  ${report.metrics.avg_net_worth:.2f}")
    print(f"   Median Net Worth:   ${report.metrics.median_net_worth:.2f}")
    print(f"   Min Net Worth:      ${report.metrics.min_net_worth:.2f}")
    print(f"   Std Deviation:      ${report.metrics.std_net_worth:.2f}")

    print("\n📈 SUCCESS METRICS")
    print(f"   Success Rate:       {report.metrics.success_rate:.1%}")
    print(f"   Profitability Rate: {report.metrics.profitability_rate:.1%}")
    print(f"   Avg Profit:         ${report.metrics.avg_profit:.2f}")

    print("\n🧠 COHERENCE ANALYSIS")
    print(f"   Coherence Score:    {report.metrics.coherence_score:.1%}")
    print(f"   Avg Errors/Run:     {report.metrics.avg_coherence_errors:.1f}")

    print("\n📦 OPERATIONAL METRICS")
    print(f"   Avg Items Sold:     {report.metrics.avg_items_sold:.1f}")
    print(f"   Avg Orders Placed:  {report.metrics.avg_orders_placed:.1f}")
    print(f"   Avg Stockout Days:  {report.metrics.avg_stockout_days:.1f}")
    print(f"   Avg Simulation Days:{report.metrics.avg_simulation_days:.1f}")

    if report.leaderboard_comparison:
        print("\n🏆 LEADERBOARD COMPARISON")
        print(f"   Our Best Score:     ${report.leaderboard_comparison.our_score:.2f}")
        print(
            f"   Rank:               #{report.leaderboard_comparison.our_rank} of {report.leaderboard_comparison.total_entries}"
        )
        print(f"   Percentile:         Top {100 - report.leaderboard_comparison.percentile:.0f}%")
        print("\n   Comparison with top models:")
        for model, score, comparison in report.leaderboard_comparison.comparisons[:5]:
            print(f"   - {model}: ${score:.2f} ({comparison})")

    print("\n" + "=" * 70)
    print(f"📁 Results saved to: {config.output_dir}")
    print("=" * 70 + "\n")

    # Print key findings
    print("KEY FINDINGS:")
    for finding in report.summary.get("key_findings", []):
        print(f"  • {finding}")

    print("\nRECOMMENDATIONS:")
    for rec in report.summary.get("recommendations", []):
        print(f"  • {rec}")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
