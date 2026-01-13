#!/usr/bin/env python3
"""
REALM-Bench and API-Bank Benchmark CLI for ElizaOS Planning Plugin.

Usage:
    python -m elizaos_plugin_planning.benchmarks.cli --all
    python -m elizaos_plugin_planning.benchmarks.cli --realm-bench
    python -m elizaos_plugin_planning.benchmarks.cli --api-bank
    python -m elizaos_plugin_planning.benchmarks.cli --all --output ./my_results
"""

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime
from typing import Any

from elizaos_plugin_planning.benchmarks.types import BenchmarkConfig
from elizaos_plugin_planning.benchmarks.benchmark_runner import BenchmarkRunner

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Planning Plugin Benchmark CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Run all benchmarks
    python -m elizaos_plugin_planning.benchmarks.cli --all

    # Run only REALM-Bench
    python -m elizaos_plugin_planning.benchmarks.cli --realm-bench

    # Run only API-Bank
    python -m elizaos_plugin_planning.benchmarks.cli --api-bank

    # Custom output directory
    python -m elizaos_plugin_planning.benchmarks.cli --all --output ./benchmark_results

    # Verbose mode with max 10 tests
    python -m elizaos_plugin_planning.benchmarks.cli --all --verbose --max-tests 10
        """,
    )

    parser.add_argument(
        "--all",
        action="store_true",
        help="Run all benchmarks (REALM-Bench and API-Bank)",
    )
    parser.add_argument(
        "--realm-bench",
        action="store_true",
        help="Run REALM-Bench benchmarks",
    )
    parser.add_argument(
        "--api-bank",
        action="store_true",
        help="Run API-Bank benchmarks",
    )
    parser.add_argument(
        "--realm-bench-path",
        type=str,
        default=None,
        help="Path to REALM-Bench data directory",
    )
    parser.add_argument(
        "--api-bank-path",
        type=str,
        default=None,
        help="Path to API-Bank data directory",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for results (default: ./benchmark_results/<timestamp>)",
    )
    parser.add_argument(
        "--max-tests",
        type=int,
        default=None,
        help="Maximum number of tests per category",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=60000,
        help="Timeout per test in milliseconds (default: 60000)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output",
    )
    parser.add_argument(
        "--no-memory",
        action="store_true",
        help="Disable memory tracking",
    )
    parser.add_argument(
        "--no-details",
        action="store_true",
        help="Don't save detailed logs",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON to stdout",
    )

    return parser.parse_args()


def create_config(args: argparse.Namespace) -> BenchmarkConfig:
    """Create benchmark configuration from arguments."""
    # Determine which benchmarks to run
    run_realm = args.realm_bench or args.all
    run_api_bank = args.api_bank or args.all

    # If nothing specified, default to all
    if not run_realm and not run_api_bank:
        run_realm = True
        run_api_bank = True

    # Generate output directory with timestamp
    if args.output:
        output_dir = args.output
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/{timestamp}"

    return BenchmarkConfig(
        realm_bench_path=args.realm_bench_path or "./benchmark-data/realm-bench",
        api_bank_path=args.api_bank_path or "./benchmark-data/api-bank",
        run_realm_bench=run_realm,
        run_api_bank=run_api_bank,
        max_tests_per_category=args.max_tests,
        timeout_ms=args.timeout,
        output_dir=output_dir,
        save_detailed_logs=not args.no_details,
        enable_metrics=True,
        enable_memory_tracking=not args.no_memory,
    )


def print_banner() -> None:
    """Print the CLI banner."""
    print("""
╔═══════════════════════════════════════════════════════════════════╗
║           ElizaOS Planning Plugin Benchmark Runner                ║
║                 REALM-Bench & API-Bank Tests                      ║
╚═══════════════════════════════════════════════════════════════════╝
""")


def print_config(config: BenchmarkConfig) -> None:
    """Print configuration summary."""
    print("📋 Configuration:")
    print(f"   REALM-Bench: {'✅ enabled' if config.run_realm_bench else '❌ disabled'}")
    if config.run_realm_bench:
        print(f"      Path: {config.realm_bench_path}")
    print(f"   API-Bank: {'✅ enabled' if config.run_api_bank else '❌ disabled'}")
    if config.run_api_bank:
        print(f"      Path: {config.api_bank_path}")
    print(f"   Output: {config.output_dir}")
    print(f"   Max Tests: {config.max_tests_per_category or 'unlimited'}")
    print(f"   Timeout: {config.timeout_ms}ms")
    print(f"   Memory Tracking: {'✅' if config.enable_memory_tracking else '❌'}")
    print(f"   Detailed Logs: {'✅' if config.save_detailed_logs else '❌'}")
    print()


def print_results_summary(results: dict[str, Any]) -> None:
    """Print a summary of benchmark results."""
    metrics = results.get("overall_metrics", {})
    summary = results.get("summary", {})

    print("\n" + "=" * 70)
    print("📊 BENCHMARK RESULTS SUMMARY")
    print("=" * 70)

    # Overall metrics
    print("\n🎯 Overall Performance:")
    print(f"   Status: {summary.get('status', 'unknown').upper()}")
    print(f"   Performance Score: {summary.get('performance_score', 0)}/100")
    print(f"   Total Tests: {metrics.get('total_tests', 0)}")
    print(f"   Passed: {metrics.get('total_passed', 0)}")
    print(f"   Success Rate: {metrics.get('overall_success_rate', 0) * 100:.1f}%")

    # Timing metrics
    print("\n⏱️  Performance Metrics:")
    print(f"   Avg Planning Time: {metrics.get('average_planning_time', 0):.0f}ms")
    print(f"   Avg Execution Time: {metrics.get('average_execution_time', 0):.0f}ms")

    # Memory usage
    memory = metrics.get("memory_usage", {})
    if memory.get("peak", 0) > 0:
        print("\n💾 Memory Usage:")
        print(f"   Peak: {memory.get('peak', 0) / 1024 / 1024:.1f}MB")
        print(f"   Average: {memory.get('average', 0) / 1024 / 1024:.1f}MB")

    # Key findings
    findings = summary.get("key_findings", [])
    if findings:
        print("\n📌 Key Findings:")
        for finding in findings:
            print(f"   • {finding}")

    # REALM-Bench specific results
    realm_results = results.get("realm_bench_results")
    if realm_results:
        print("\n🏆 REALM-Bench Results:")
        print(f"   Tests: {realm_results.get('total_tests', 0)}")
        print(f"   Passed: {realm_results.get('passed_tests', 0)}")
        passed = realm_results.get("passed_tests", 0)
        total = realm_results.get("total_tests", 1)
        print(f"   Success Rate: {passed / total * 100:.1f}%")
        print(f"   Plan Quality: {realm_results.get('average_plan_quality', 0) * 100:.1f}%")
        print(f"   Goal Achievement: {realm_results.get('average_goal_achievement', 0) * 100:.1f}%")
        print(f"   Efficiency: {realm_results.get('average_efficiency', 0) * 100:.1f}%")

    # API-Bank specific results
    api_results = results.get("api_bank_results")
    if api_results:
        print("\n🔌 API-Bank Results:")
        print(f"   Tests: {api_results.get('total_tests', 0)}")
        print(f"   Passed: {api_results.get('passed_tests', 0)}")
        passed = api_results.get("passed_tests", 0)
        total = api_results.get("total_tests", 1)
        print(f"   Success Rate: {passed / total * 100:.1f}%")
        api_metrics = api_results.get("overall_metrics", {})
        print(f"   API Call Accuracy: {api_metrics.get('average_api_call_accuracy', 0) * 100:.1f}%")
        print(f"   Response Quality: {api_metrics.get('average_response_quality', 0) * 100:.1f}%")

        # Level breakdown
        levels = api_results.get("level_breakdown", {})
        if levels:
            print("\n   Level Breakdown:")
            for level, stats in sorted(levels.items()):
                print(
                    f"      Level {level}: {stats.get('passed', 0)}/{stats.get('total', 0)} "
                    f"({stats.get('success_rate', 0) * 100:.1f}%)"
                )

    # Comparison / Recommendations
    comparison = results.get("comparison", {})
    sw = comparison.get("strengths_and_weaknesses", {})

    strengths = sw.get("strengths", [])
    if strengths:
        print("\n💪 Strengths:")
        for s in strengths[:5]:
            print(f"   • {s}")

    weaknesses = sw.get("weaknesses", [])
    if weaknesses:
        print("\n⚠️  Areas for Improvement:")
        for w in weaknesses[:5]:
            print(f"   • {w}")

    recommendations = sw.get("recommendations", [])
    if recommendations:
        print("\n💡 Recommendations:")
        for r in recommendations[:5]:
            print(f"   • {r}")

    print("\n" + "=" * 70)


async def run_benchmarks(config: BenchmarkConfig, verbose: bool = False) -> dict[str, Any]:
    """Run the benchmarks with the given configuration."""
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    runner = BenchmarkRunner(config)
    results = await runner.run_benchmarks()

    # Convert to dict for serialization
    from dataclasses import asdict

    results_dict = {
        "metadata": results.metadata,
        "overall_metrics": results.overall_metrics,
        "comparison": results.comparison,
        "summary": results.summary,
    }

    if results.realm_bench_results:
        results_dict["realm_bench_results"] = asdict(results.realm_bench_results)

    if results.api_bank_results:
        results_dict["api_bank_results"] = asdict(results.api_bank_results)

    return results_dict


def main() -> int:
    """Main entry point for the CLI."""
    args = parse_args()

    if not args.json:
        print_banner()

    config = create_config(args)

    if not args.json:
        print_config(config)
        print("🚀 Starting benchmarks...\n")

    try:
        results = asyncio.run(run_benchmarks(config, args.verbose))

        if args.json:
            print(json.dumps(results, indent=2, default=str))
        else:
            print_results_summary(results)

            # Show output location
            print(f"\n📁 Full results saved to: {config.output_dir}/")
            print("   - benchmark-results.json (detailed results)")
            print("   - benchmark-summary.md (human-readable summary)")

            if config.save_detailed_logs:
                if config.run_realm_bench:
                    print("   - realm-bench-detailed.json")
                if config.run_api_bank:
                    print("   - api-bank-detailed.json")

            print("\n✅ Benchmark completed successfully!")

        return 0

    except KeyboardInterrupt:
        if not args.json:
            print("\n\n⚠️  Benchmark interrupted by user")
        return 130

    except Exception as e:
        if args.json:
            print(json.dumps({"error": str(e)}, indent=2))
        else:
            logger.error(f"Benchmark failed: {e}")
            print(f"\n❌ Benchmark failed: {e}")

            if args.verbose:
                import traceback

                traceback.print_exc()
            else:
                print("   Run with --verbose for more details")

        return 1


if __name__ == "__main__":
    sys.exit(main())
