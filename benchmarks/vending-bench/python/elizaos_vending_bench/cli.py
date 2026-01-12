"""
Vending-Bench CLI

Command-line interface for running the Vending-Bench benchmark.
"""

import argparse
import asyncio
import json
import logging
import sys
from decimal import Decimal
from pathlib import Path

from elizaos_vending_bench.agent import LLMProvider
from elizaos_vending_bench.reporting import VendingBenchReporter
from elizaos_vending_bench.runner import VendingBenchRunner
from elizaos_vending_bench.types import (
    CoherenceError,
    CoherenceErrorType,
    LeaderboardComparison,
    VendingBenchConfig,
    VendingBenchMetrics,
    VendingBenchReport,
    VendingBenchResult,
)

# Load repo-root .env if present (optional)
try:
    from dotenv import load_dotenv  # type: ignore

    repo_root = Path(__file__).resolve().parents[4]
    env_path = repo_root / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Run the Vending-Bench benchmark for ElizaOS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run with default settings (heuristic agent)
  vending-bench run

  # Run with specific number of runs and days
  vending-bench run --runs 10 --days 30

  # Run with a specific model
  vending-bench run --model gpt-4 --runs 5

  # Run with OpenAI API
  vending-bench run --provider openai --api-key sk-...

  # Generate report only from existing results
  vending-bench report --input results.json
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Run command
    run_parser = subparsers.add_parser("run", help="Run the benchmark")
    run_parser.add_argument(
        "--runs",
        type=int,
        default=5,
        help="Number of simulation runs (default: 5)",
    )
    run_parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Maximum days per run (default: 30)",
    )
    run_parser.add_argument(
        "--initial-cash",
        type=float,
        default=500.0,
        help="Starting cash amount (default: 500.0)",
    )
    run_parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducibility",
    )
    run_parser.add_argument(
        "--model",
        type=str,
        default="heuristic",
        help="Model to use (default: heuristic)",
    )
    run_parser.add_argument(
        "--provider",
        type=str,
        choices=["openai", "anthropic", "heuristic"],
        default="heuristic",
        help="LLM provider (default: heuristic)",
    )
    run_parser.add_argument(
        "--api-key",
        type=str,
        default=None,
        help="API key for LLM provider",
    )
    run_parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Temperature for LLM generation (default: 0.0)",
    )
    run_parser.add_argument(
        "--output-dir",
        type=str,
        default="./benchmark_results/vending-bench",
        help="Output directory for results",
    )
    run_parser.add_argument(
        "--no-report",
        action="store_true",
        help="Skip generating markdown report",
    )
    run_parser.add_argument(
        "--no-leaderboard",
        action="store_true",
        help="Skip leaderboard comparison",
    )
    run_parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    # Report command
    report_parser = subparsers.add_parser("report", help="Generate report from results")
    report_parser.add_argument(
        "--input",
        type=str,
        required=True,
        help="Input JSON results file",
    )
    report_parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output markdown file (default: derived from input)",
    )

    # Info command
    subparsers.add_parser("info", help="Show benchmark information")

    return parser.parse_args()


async def run_benchmark(args: argparse.Namespace) -> int:
    """Execute the benchmark run."""
    setup_logging(args.verbose)
    logger = logging.getLogger(__name__)

    # Build config
    config = VendingBenchConfig(
        num_runs=args.runs,
        max_days_per_run=args.days,
        initial_cash=Decimal(str(args.initial_cash)),
        random_seed=args.seed,
        model_name=args.model,
        temperature=args.temperature,
        output_dir=args.output_dir,
        generate_report=not args.no_report,
        compare_leaderboard=not args.no_leaderboard,
    )

    # Setup LLM provider if specified
    llm_provider: LLMProvider | None = None
    if args.provider == "openai":
        try:
            from elizaos_vending_bench.providers.openai import OpenAIProvider

            llm_provider = OpenAIProvider(
                api_key=args.api_key,
                model=args.model,
            )
            logger.info(f"Using OpenAI provider with model {args.model}")
        except ImportError:
            logger.warning("OpenAI provider not available, falling back to heuristic")
        except ValueError as e:
            logger.warning(f"OpenAI provider not configured ({e}), falling back to heuristic")

    elif args.provider == "anthropic":
        try:
            from elizaos_vending_bench.providers.anthropic import AnthropicProvider

            llm_provider = AnthropicProvider(
                api_key=args.api_key,
                model=args.model,
            )
            logger.info(f"Using Anthropic provider with model {args.model}")
        except ImportError:
            logger.warning("Anthropic provider not available, falling back to heuristic")
        except ValueError as e:
            logger.warning(f"Anthropic provider not configured ({e}), falling back to heuristic")

    # Run benchmark
    runner = VendingBenchRunner(config, llm_provider)

    logger.info("=" * 60)
    logger.info("Starting Vending-Bench Evaluation")
    logger.info("=" * 60)
    logger.info(f"Runs: {config.num_runs}")
    logger.info(f"Days per run: {config.max_days_per_run}")
    logger.info(f"Initial cash: ${config.initial_cash}")
    logger.info(f"Model: {config.model_name}")
    logger.info("=" * 60)

    report = await runner.run_benchmark()

    # Print summary
    print("\n" + "=" * 60)
    print("BENCHMARK COMPLETE")
    print("=" * 60)
    print(f"Best Net Worth: ${report.metrics.max_net_worth:.2f}")
    print(f"Average Net Worth: ${report.metrics.avg_net_worth:.2f}")
    print(f"Profitability Rate: {report.metrics.profitability_rate:.1%}")
    print(f"Coherence Score: {report.metrics.coherence_score:.1%}")

    if report.leaderboard_comparison:
        print(f"\nLeaderboard Rank: #{report.leaderboard_comparison.our_rank}")

    print("\n" + "=" * 60)

    if config.generate_report:
        print(f"\nResults saved to: {config.output_dir}")

    return 0


def _to_decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _to_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except Exception:
            try:
                return int(float(value))
            except Exception:
                return default
    return default


def _to_float(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except Exception:
            return default
    return default


def generate_report_from_results(args: argparse.Namespace) -> int:
    """Generate a markdown report from a saved JSON results file."""
    input_path = Path(str(args.input))
    if not input_path.exists():
        print(f"Input file not found: {input_path}")
        return 1

    data_obj = json.loads(input_path.read_text())
    if not isinstance(data_obj, dict):
        print("Invalid JSON: expected a top-level object")
        return 1

    metadata_raw = data_obj.get("metadata")
    metadata: dict[str, str | int | float | bool] = {}
    if isinstance(metadata_raw, dict):
        for k, v in metadata_raw.items():
            if isinstance(v, (str, int, float, bool)):
                metadata[str(k)] = v
            else:
                metadata[str(k)] = str(v)

    config_raw = data_obj.get("config", {})
    config = VendingBenchConfig(
        num_runs=_to_int(config_raw.get("num_runs", 1)) if isinstance(config_raw, dict) else 1,
        max_days_per_run=_to_int(config_raw.get("max_days_per_run", 30))
        if isinstance(config_raw, dict)
        else 30,
        initial_cash=_to_decimal(config_raw.get("initial_cash", "500.00"))
        if isinstance(config_raw, dict)
        else Decimal("500.00"),
        model_name=str(config_raw.get("model_name", "unknown"))
        if isinstance(config_raw, dict)
        else "unknown",
        generate_report=True,
    )

    results_raw = data_obj.get("results", [])
    results: list[VendingBenchResult] = []
    if isinstance(results_raw, list):
        for r in results_raw:
            if not isinstance(r, dict):
                continue
            coherence_count = _to_int(r.get("coherence_errors", 0))
            coherence_errors = [
                CoherenceError(
                    error_type=CoherenceErrorType.LOOP_BEHAVIOR,
                    day=0,
                    description="(placeholder from summary JSON)",
                    severity=0.0,
                )
                for _ in range(coherence_count)
            ]

            results.append(
                VendingBenchResult(
                    run_id=str(r.get("run_id", "")),
                    simulation_days=_to_int(r.get("simulation_days", 0)),
                    final_net_worth=_to_decimal(r.get("final_net_worth", "0")),
                    initial_cash=config.initial_cash,
                    profit=_to_decimal(r.get("profit", "0")),
                    total_revenue=_to_decimal(r.get("total_revenue", "0")),
                    total_costs=_to_decimal(r.get("total_costs", "0")),
                    total_operational_fees=_to_decimal(r.get("total_operational_fees", "0")),
                    items_sold=_to_int(r.get("items_sold", 0)),
                    orders_placed=_to_int(r.get("orders_placed", 0)),
                    successful_deliveries=_to_int(r.get("successful_deliveries", 0)),
                    stockout_days=_to_int(r.get("stockout_days", 0)),
                    coherence_errors=coherence_errors,
                    total_tokens=_to_int(r.get("total_tokens", 0)),
                    total_latency_ms=_to_float(r.get("total_latency_ms", 0.0)),
                    error=str(r.get("error")) if r.get("error") is not None else None,
                )
            )

    # Metrics: prefer stored values, but fill any missing required fields
    metrics_raw = data_obj.get("metrics", {})
    if not isinstance(metrics_raw, dict):
        metrics_raw = {}

    net_worths = [float(r.final_net_worth) for r in results] or [0.0]
    profits = [float(r.profit) for r in results] or [0.0]
    total_days = sum(r.simulation_days for r in results)
    total_tokens = sum(r.total_tokens for r in results)

    error_breakdown_raw = metrics_raw.get("error_breakdown", {})
    error_breakdown: dict[CoherenceErrorType, int] = {}
    if isinstance(error_breakdown_raw, dict):
        for k, v in error_breakdown_raw.items():
            try:
                error_type = CoherenceErrorType(str(k))
            except Exception:
                continue
            error_breakdown[error_type] = _to_int(v)

    metrics = VendingBenchMetrics(
        avg_net_worth=_to_decimal(metrics_raw.get("avg_net_worth", "0")),
        max_net_worth=_to_decimal(metrics_raw.get("max_net_worth", "0")),
        min_net_worth=_to_decimal(metrics_raw.get("min_net_worth", "0")),
        std_net_worth=_to_decimal(metrics_raw.get("std_net_worth", "0")),
        median_net_worth=_to_decimal(sorted(net_worths)[len(net_worths) // 2]),
        success_rate=_to_float(metrics_raw.get("success_rate", 0.0)),
        avg_profit=_to_decimal(sum(profits) / len(profits) if profits else 0.0),
        profitability_rate=_to_float(metrics_raw.get("profitability_rate", 0.0)),
        avg_items_sold=_to_float(metrics_raw.get("avg_items_sold", 0.0)),
        avg_orders_placed=_to_float(metrics_raw.get("avg_orders_placed", 0.0)),
        avg_stockout_days=_to_float(metrics_raw.get("avg_stockout_days", 0.0)),
        avg_simulation_days=_to_float(metrics_raw.get("avg_simulation_days", 0.0)),
        coherence_score=_to_float(metrics_raw.get("coherence_score", 0.0)),
        avg_coherence_errors=_to_float(metrics_raw.get("avg_coherence_errors", 0.0)),
        avg_tokens_per_run=_to_float(metrics_raw.get("avg_tokens_per_run", 0.0)),
        avg_tokens_per_day=(total_tokens / total_days) if total_days > 0 else 0.0,
        avg_latency_per_action_ms=_to_float(metrics_raw.get("avg_latency_per_action_ms", 0.0)),
        error_breakdown=error_breakdown,
    )

    leaderboard_raw = data_obj.get("leaderboard_comparison")
    leaderboard: LeaderboardComparison | None = None
    if isinstance(leaderboard_raw, dict):
        comparisons_raw = leaderboard_raw.get("comparisons", [])
        comparisons: list[tuple[str, Decimal, str]] = []
        if isinstance(comparisons_raw, list):
            for c in comparisons_raw:
                if not isinstance(c, dict):
                    continue
                comparisons.append(
                    (
                        str(c.get("model", "")),
                        _to_decimal(c.get("score", "0")),
                        str(c.get("comparison", "")),
                    )
                )
        leaderboard = LeaderboardComparison(
            our_score=_to_decimal(leaderboard_raw.get("our_score", "0")),
            our_rank=_to_int(leaderboard_raw.get("our_rank", 0)),
            total_entries=_to_int(leaderboard_raw.get("total_entries", 0)),
            percentile=_to_float(leaderboard_raw.get("percentile", 0.0)),
            comparisons=comparisons,
        )

    summary_raw = data_obj.get("summary", {})
    summary: dict[str, str | list[str]] = {}
    if isinstance(summary_raw, dict):
        for k, v in summary_raw.items():
            if isinstance(v, str):
                summary[str(k)] = v
            elif isinstance(v, list) and all(isinstance(i, str) for i in v):
                summary[str(k)] = v
            else:
                summary[str(k)] = str(v)

    report = VendingBenchReport(
        metadata=metadata,
        config=config,
        results=results,
        metrics=metrics,
        leaderboard_comparison=leaderboard,
        summary=summary,
    )

    reporter = VendingBenchReporter()
    markdown = reporter.generate_report(report)

    if args.output:
        output_path = Path(str(args.output))
    else:
        # If file looks like vending-bench-results-<timestamp>.json, derive a matching report name
        stem = input_path.stem
        timestamp = (
            stem.split("vending-bench-results-")[-1] if "vending-bench-results-" in stem else ""
        )
        if timestamp:
            output_path = input_path.with_name(f"VENDING-BENCH-REPORT-{timestamp}.md")
        else:
            output_path = input_path.with_suffix(".md")

    output_path.write_text(markdown)
    print(f"Wrote report to: {output_path}")
    return 0


def show_info() -> int:
    """Show benchmark information."""
    print("""
Vending-Bench Benchmark for ElizaOS
===================================

Vending-Bench evaluates LLM agents on long-term coherence by simulating
the operation of a vending machine business.

Reference:
  - Paper: https://arxiv.org/abs/2502.15840
  - Leaderboard: https://andonlabs.com/evals/vending-bench

Current Leaderboard Scores:
  1. Grok 4:           $4,694.15
  2. Claude 3.5 Sonnet: $2,217.93
  3. Claude Opus 4:     $2,077.41

Benchmark Parameters:
  - Initial Capital: $500
  - Machine: 4 rows × 3 columns (12 slots)
  - Simulation: Up to 30 days
  - Products: 12 (beverages, snacks, healthy)
  - Suppliers: 3 (different lead times)

Evaluation:
  - Net Worth = Cash on Hand + Cash in Machine + Inventory
  - Coherence Score = Based on decision errors
  - Success = Net Worth > Initial Capital
""")
    return 0


def main() -> int:
    """Main entry point."""
    args = parse_args()

    if args.command == "run":
        return asyncio.run(run_benchmark(args))
    elif args.command == "report":
        return generate_report_from_results(args)
    elif args.command == "info":
        return show_info()
    else:
        print("Use 'vending-bench run' to execute the benchmark")
        print("Use 'vending-bench info' for benchmark information")
        print("Use 'vending-bench --help' for all options")
        return 0


if __name__ == "__main__":
    sys.exit(main())
