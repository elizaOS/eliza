#!/usr/bin/env python3
"""
Tau-bench Benchmark CLI for ElizaOS.

Usage:
    python -m elizaos_tau_bench.cli --all
    python -m elizaos_tau_bench.cli --domain retail
    python -m elizaos_tau_bench.cli --domain airline
    python -m elizaos_tau_bench.cli --trials 8 --output ./results
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from elizaos_tau_bench.types import TauBenchConfig, TauDomain, TaskDifficulty
from elizaos_tau_bench.runner import TauBenchRunner

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

def _maybe_load_dotenv() -> None:
    """
    Best-effort loading of environment variables from .env.

    This is optional (no hard dependency on python-dotenv). When available, we load:
    - A local file next to this CLI: `.env.tau-bench` (if present)
    - The nearest `.env` found by searching upwards from CWD
    """
    try:
        from dotenv import find_dotenv, load_dotenv  # type: ignore[import-not-found]
    except Exception:
        return

    try:
        # Prefer a benchmark-specific env file if present
        local_env = Path(__file__).resolve().parent.parent / ".env.tau-bench"
        if local_env.exists():
            load_dotenv(local_env, override=False)

        # Then load the nearest .env from the current working directory upward
        env_path = find_dotenv(usecwd=True)
        if env_path:
            load_dotenv(env_path, override=False)
    except Exception:
        # Never fail the CLI because dotenv couldn't load
        return


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="ElizaOS Tau-bench Benchmark CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Run all benchmarks (retail + airline)
    python -m elizaos_tau_bench.cli --all

    # Run only retail domain
    python -m elizaos_tau_bench.cli --domain retail

    # Run with multiple trials for Pass^k evaluation
    python -m elizaos_tau_bench.cli --all --trials 8

    # Custom output directory
    python -m elizaos_tau_bench.cli --all --output ./benchmark_results

    # Verbose mode with max 10 tasks
    python -m elizaos_tau_bench.cli --all --verbose --max-tasks 10

    # Use sample tasks (no external data required)
    python -m elizaos_tau_bench.cli --sample
        """,
    )

    parser.add_argument(
        "--all",
        action="store_true",
        help="Run benchmarks for all domains",
    )
    parser.add_argument(
        "--domain",
        type=str,
        choices=["retail", "airline"],
        help="Run benchmark for a specific domain",
    )
    parser.add_argument(
        "--sample",
        action="store_true",
        help="Use sample tasks (no external data required)",
    )
    parser.add_argument(
        "--data-path",
        type=str,
        default="./benchmark-data/tau-bench",
        help="Path to benchmark data directory",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for results",
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=1,
        help="Number of trials per task (for Pass^k evaluation)",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum number of tasks per domain",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=15,
        help="Maximum turns per task",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120000,
        help="Timeout per task in milliseconds",
    )
    parser.add_argument(
        "--difficulty",
        type=str,
        choices=["easy", "medium", "hard"],
        default=None,
        help="Filter tasks by difficulty",
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
    parser.add_argument(
        "--llm-judge",
        action="store_true",
        help="Use LLM to judge response quality",
    )
    
    # ElizaOS integration options
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use mock agent instead of real LLM (for testing)",
    )
    parser.add_argument(
        "--real-llm",
        action="store_true",
        help="(deprecated, now the default) Use real LLM via ElizaOS",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="LLM temperature for generation (default: 0.0)",
    )
    parser.add_argument(
        "--model-provider",
        type=str,
        choices=["openai", "groq", "openrouter", "anthropic", "google", "ollama", "milady"],
        default=None,
        help="Force specific model provider (auto-detected if not set; 'milady' uses TS agent)",
    )

    # Trajectory logging (for training/benchmarks)
    parser.add_argument(
        "--trajectories",
        action="store_true",
        help="Enable trajectory logging + export (requires elizaos-plugin-trajectory-logger)",
    )
    parser.add_argument(
        "--no-trajectories",
        action="store_true",
        help="Disable trajectory logging even if available",
    )
    parser.add_argument(
        "--trajectory-format",
        type=str,
        choices=["art", "grpo"],
        default="art",
        help="Trajectory export format (art jsonl or grpo grouped json)",
    )

    return parser.parse_args()


def create_config(args: argparse.Namespace) -> TauBenchConfig:
    """Create benchmark configuration from arguments."""
    # Determine which domains to run
    if args.domain:
        domains = [TauDomain(args.domain)]
    elif args.all:
        domains = list(TauDomain)
    else:
        # Default to all domains
        domains = list(TauDomain)

    # Parse difficulty
    difficulty = None
    if args.difficulty:
        difficulty = TaskDifficulty(args.difficulty)

    # Generate output directory with timestamp
    if args.output:
        output_dir = args.output
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/tau-bench/{timestamp}"

    # Use sample data path if sample flag is set
    data_path = args.data_path
    if args.sample:
        data_path = "./sample-data"  # Will trigger sample task generation

    return TauBenchConfig(
        data_path=data_path,
        output_dir=output_dir,
        domains=domains,
        max_tasks=args.max_tasks,
        difficulty=difficulty,
        num_trials=args.trials,
        max_turns_per_task=args.max_turns,
        timeout_ms=args.timeout,
        save_detailed_logs=not args.no_details,
        enable_metrics=True,
        enable_memory_tracking=not args.no_memory,
        use_llm_judge=args.llm_judge,
        verbose=args.verbose,
        # ElizaOS integration
        use_mock=bool(args.mock),
        temperature=args.temperature,
        model_provider=args.model_provider,
        enable_trajectory_logging=(args.trajectories or not args.mock) and not args.no_trajectories,
        trajectory_export_format=args.trajectory_format,
    )


def print_banner() -> None:
    """Print the CLI banner."""
    print("""
╔═══════════════════════════════════════════════════════════════════════╗
║                  ElizaOS Tau-bench Benchmark Runner                   ║
║           Tool-Agent-User Interaction in Real-World Domains           ║
╚═══════════════════════════════════════════════════════════════════════╝
""")


def print_config(config: TauBenchConfig) -> None:
    """Print configuration summary."""
    print("📋 Configuration:")
    print(f"   Domains: {', '.join(d.value for d in config.domains)}")
    print(f"   Data Path: {config.data_path}")
    print(f"   Output: {config.output_dir}")
    print(f"   Trials per Task: {config.num_trials}")
    print(f"   Max Tasks: {config.max_tasks or 'unlimited'}")
    print(f"   Max Turns: {config.max_turns_per_task}")
    print(f"   Timeout: {config.timeout_ms}ms")
    print(f"   Memory Tracking: {'✅' if config.enable_memory_tracking else '❌'}")
    print(f"   LLM Judge: {'✅' if config.use_llm_judge else '❌'}")
    print(f"   Mode: {'🤖 Real LLM (ElizaOS)' if not config.use_mock else '🧪 Mock Mode'}")
    if not config.use_mock:
        print(f"   Temperature: {config.temperature}")
        print(f"   Provider: {config.model_provider or 'auto-detect'}")
    print(
        f"   Trajectories: {'✅' if config.enable_trajectory_logging else '❌'} "
        f"({config.trajectory_export_format})"
    )
    print()


def print_results_summary(results: dict) -> None:
    """Print a summary of benchmark results."""
    summary = results.get("summary", {})

    print("\n" + "=" * 70)
    print("📊 TAU-BENCH RESULTS SUMMARY")
    print("=" * 70)

    # Overall metrics
    print("\n🎯 Overall Performance:")
    print(f"   Status: {summary.get('status', 'unknown').upper()}")
    print(f"   Success Rate: {results.get('overall_success_rate', 0) * 100:.1f}%")
    print(f"   Total Tasks: {results.get('total_tasks', 0)} ({results.get('total_trials', 0)} trials)")
    print(f"   Passed: {results.get('passed_tasks', 0)}")

    # Pass^k metrics
    pass_k = results.get("pass_k_metrics", {})
    if pass_k:
        print("\n📈 Pass^k Reliability:")
        for k, metrics in sorted(pass_k.items()):
            if isinstance(metrics, dict):
                print(f"   Pass^{k}: {metrics.get('pass_rate', 0) * 100:.1f}%")

    # Performance metrics
    print("\n⚡ Performance Metrics:")
    print(f"   Tool Accuracy: {results.get('overall_tool_accuracy', 0) * 100:.1f}%")
    print(f"   Policy Compliance: {results.get('overall_policy_compliance', 0) * 100:.1f}%")
    print(f"   Response Quality: {results.get('overall_response_quality', 0) * 100:.1f}%")
    print(f"   Avg Duration: {results.get('average_duration_ms', 0):.0f}ms")

    # Leaderboard comparison
    comparison = results.get("comparison_to_leaderboard", {})
    if comparison.get("best_comparable_model"):
        print("\n🏆 Leaderboard Comparison:")
        print(f"   Closest Model: {comparison.get('best_comparable_model', 'N/A')}")
        diff = comparison.get("difference_from_best", 0)
        direction = "better" if diff > 0 else "behind"
        print(f"   Difference: {abs(diff) * 100:.1f}% {direction}")

    # Key findings
    findings = summary.get("key_findings", [])
    if findings:
        print("\n📌 Key Findings:")
        for finding in findings:
            print(f"   • {finding}")

    # Strengths
    strengths = summary.get("strengths", [])
    if strengths:
        print("\n💪 Strengths:")
        for s in strengths[:5]:
            print(f"   ✅ {s}")

    # Weaknesses
    weaknesses = summary.get("weaknesses", [])
    if weaknesses:
        print("\n⚠️ Areas for Improvement:")
        for w in weaknesses[:5]:
            print(f"   • {w}")

    # Recommendations
    recommendations = summary.get("recommendations", [])
    if recommendations:
        print("\n💡 Recommendations:")
        for r in recommendations[:5]:
            print(f"   • {r}")

    print("\n" + "=" * 70)


async def run_benchmark(config: TauBenchConfig, verbose: bool = False):
    """Run the benchmark with the given configuration."""
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    runner = TauBenchRunner(config)
    report = await runner.run_benchmark()

    # Convert to dict for output
    return runner._report_to_dict(report)


def main() -> int:
    """Main entry point for the CLI."""
    _maybe_load_dotenv()
    args = parse_args()

    if not args.json:
        print_banner()

    config = create_config(args)

    if config.use_mock:
        logger.warning(
            "WARNING: Running in mock mode. Results are not representative of real agent performance."
        )
    else:
        provider = (config.model_provider or os.environ.get("BENCHMARK_MODEL_PROVIDER", "")).strip().lower()
        if not provider:
            if os.environ.get("GROQ_API_KEY"):
                provider = "groq"
            elif os.environ.get("OPENROUTER_API_KEY"):
                provider = "openrouter"
            elif os.environ.get("OPENAI_API_KEY"):
                provider = "openai"
        key_var = {
            "openai": "OPENAI_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "google": "GOOGLE_API_KEY",
        }.get(provider, "OPENAI_API_KEY")
        if not os.environ.get(key_var):
            logger.error(
                "ERROR: No API key found for provider '%s'. Set %s or use --mock.",
                provider or "auto",
                key_var,
            )
            return 1

    if not args.json:
        print_config(config)
        print("🚀 Starting Tau-bench evaluation...\n")

    try:
        results = asyncio.run(run_benchmark(config, args.verbose))

        if args.json:
            print(json.dumps(results, indent=2, default=str))
        else:
            print_results_summary(results)

            # Show output location
            print(f"\n📁 Full results saved to: {config.output_dir}/")
            print("   - tau-bench-results.json (main results)")
            print("   - tau-bench-summary.md (human-readable summary)")

            if config.save_detailed_logs:
                print("   - tau-bench-detailed.json (per-task details)")

            print("\n✅ Tau-bench evaluation completed successfully!")

        return 0

    except KeyboardInterrupt:
        if not args.json:
            print("\n\n⚠️ Benchmark interrupted by user")
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
