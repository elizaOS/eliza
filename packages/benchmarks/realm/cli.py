#!/usr/bin/env python3
"""
REALM-Bench CLI

Command-line interface for running REALM benchmark evaluations.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from benchmarks.realm.types import (
    ExecutionModel,
    LEADERBOARD_SCORES,
    REALMCategory,
    REALMConfig,
    REALMReport,
)
from benchmarks.realm.runner import REALMRunner

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def _parse_env_line(line: str) -> tuple[str, str] | None:
    """Parse a single .env line into (key, value)."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    return key, value


def load_env_file(path: Path, *, override: bool = False) -> dict[str, str]:
    """
    Load environment variables from a .env-style file.

    - Does NOT print secrets
    - By default does NOT override existing environment variables
    """
    loaded: dict[str, str] = {}
    if not path.exists() or not path.is_file():
        return loaded
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            parsed = _parse_env_line(raw_line)
            if not parsed:
                continue
            key, value = parsed
            if not override and key in os.environ:
                continue
            os.environ[key] = value
            loaded[key] = value
    except Exception as e:
        logger.debug(f"[REALM CLI] Failed loading env file {path}: {e}")
    return loaded


def load_root_env() -> None:
    """Load a root .env file if present (without overriding existing env)."""
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            load_env_file(candidate, override=False)
            return


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="REALM-Bench: Real-World Planning Benchmark for ElizaOS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Run all benchmark tasks
    python -m benchmarks.realm.cli

    # Run specific categories
    python -m benchmarks.realm.cli --categories sequential reactive

    # Limit tasks per category
    python -m benchmarks.realm.cli --max-tasks 5

    # Custom output directory
    python -m benchmarks.realm.cli --output ./my_results

    # Run with verbose logging
    python -m benchmarks.realm.cli --verbose

    # Show leaderboard comparison only
    python -m benchmarks.realm.cli --leaderboard
        """,
    )

    parser.add_argument(
        "--data-path",
        type=str,
        default="./data/realm",
        help="Path to REALM benchmark data (default: ./data/realm)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for results",
    )
    parser.add_argument(
        "--categories",
        type=str,
        nargs="+",
        choices=["sequential", "reactive", "complex", "multi_agent", "tool_use", "reasoning"],
        default=None,
        help="Categories to run (default: all)",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum tasks per category",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=15,
        help="Maximum steps per task (default: 15)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120000,
        help="Timeout per task in milliseconds (default: 120000)",
    )
    parser.add_argument(
        "--execution-model",
        type=str,
        choices=["sequential", "parallel", "dag"],
        default="dag",
        help="Plan execution model (default: dag)",
    )
    parser.add_argument(
        "--no-adaptation",
        action="store_true",
        help="Disable plan adaptation",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4",
        help="Model name for reporting (default: gpt-4)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose output",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["eliza", "mock", "local"],
        default="eliza",
        help="Agent provider to use (default: eliza)",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use the deterministic local mock agent for smoke tests",
    )
    parser.add_argument(
        "--leaderboard",
        action="store_true",
        help="Show leaderboard scores and exit",
    )
    parser.add_argument(
        "--no-save",
        action="store_true",
        help="Don't save results to files",
    )
    parser.add_argument(
        "--check-env",
        action="store_true",
        help="Check environment for API keys and exit",
    )
    parser.add_argument(
        "--export-trajectories",
        action="store_true",
        help="Export trajectories for training (ART/GRPO formats)",
    )
    parser.add_argument(
        "--no-trajectory-logging",
        action="store_true",
        help="Disable trajectory logging (reduces memory usage)",
    )

    return parser.parse_args()


def print_banner() -> None:
    """Print the CLI banner."""
    print("""
╔═══════════════════════════════════════════════════════════════════╗
║            REALM-Bench: Real-World Planning Benchmark             ║
║                        for ElizaOS                                ║
╠═══════════════════════════════════════════════════════════════════╣
║  Paper: https://arxiv.org/abs/2412.13102                         ║
║  GitHub: https://github.com/genglongling/REALM-Bench             ║
╚═══════════════════════════════════════════════════════════════════╝
""")


def print_leaderboard() -> None:
    """Print the REALM-Bench leaderboard."""
    print("\n📊 REALM-Bench Leaderboard (Reference Scores)")
    print("=" * 80)
    print(f"{'Model':<20} {'Sequential':>10} {'Reactive':>10} {'Complex':>10} {'Multi-Agent':>12} {'Overall':>10}")
    print("-" * 80)

    for model, scores in sorted(
        LEADERBOARD_SCORES.items(),
        key=lambda x: x[1].get("overall", 0),
        reverse=True,
    ):
        print(
            f"{model:<20} "
            f"{scores.get('sequential', 0):>9.1f}% "
            f"{scores.get('reactive', 0):>9.1f}% "
            f"{scores.get('complex', 0):>9.1f}% "
            f"{scores.get('multi_agent', 0):>11.1f}% "
            f"{scores.get('overall', 0):>9.1f}%"
        )

    print("=" * 80)
    print("\nNote: These are approximate scores based on the REALM-Bench paper.")
    print("Actual performance varies based on prompting strategy and task setup.\n")


def check_environment() -> dict[str, bool]:
    """Check environment for API keys and the eliza TS bench server."""
    results: dict[str, bool] = {}

    # Check API keys
    api_keys = [
        ("OPENAI_API_KEY", "OpenAI"),
        ("ANTHROPIC_API_KEY", "Anthropic"),
        ("GOOGLE_GENERATIVE_AI_API_KEY", "Google Generative AI"),
        ("GROQ_API_KEY", "Groq"),
    ]

    print("\n🔑 API Key Status:")
    for env_var, name in api_keys:
        has_key = bool(os.environ.get(env_var))
        results[env_var] = has_key
        status = "✅ Found" if has_key else "❌ Not set"
        print(f"   {name}: {status}")

    # Check eliza TS bridge server
    print("\n🌉 Eliza TS Bridge:")
    bench_url = os.environ.get("ELIZA_BENCH_URL")
    if bench_url:
        results["eliza_bench_url"] = True
        print(f"   ELIZA_BENCH_URL: ✅ {bench_url}")
    else:
        results["eliza_bench_url"] = False
        print("   ELIZA_BENCH_URL: ❌ unset (will auto-spawn ElizaServerManager)")

    print("\n📋 Summary:")
    if any(results.get(k) for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY")):
        print("   ✅ At least one LLM provider key detected — ready for live runs.")
    else:
        print("   ⚠️  No LLM provider keys detected. Set GROQ_API_KEY/OPENAI_API_KEY/ANTHROPIC_API_KEY.")
    if not results["eliza_bench_url"]:
        print("   ℹ️  ELIZA_BENCH_URL is unset; live runs will try to auto-spawn the TS bridge.")
    
    print()
    return results


def create_config(args: argparse.Namespace) -> REALMConfig:
    """Create benchmark configuration from arguments."""
    # Parse categories
    categories = None
    if args.categories:
        categories = [REALMCategory(c) for c in args.categories]

    # Generate output directory with timestamp
    if args.output:
        output_dir = args.output
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/realm/{timestamp}"

    return REALMConfig(
        data_path=args.data_path,
        output_dir=output_dir,
        max_tasks_per_category=args.max_tasks,
        timeout_per_task_ms=args.timeout,
        max_steps=args.max_steps,
        execution_model=ExecutionModel(args.execution_model),
        categories=categories,
        enable_adaptation=not args.no_adaptation,
        save_detailed_logs=True,
        save_trajectories=True,
        generate_report=not args.no_save,
        model_name=args.model,
    )


def print_results_summary(report: REALMReport) -> None:
    """Print summary of benchmark results."""
    metrics = report.metrics
    summary = report.summary

    status_val = summary.get("status", "unknown")
    status_str = status_val.upper() if isinstance(status_val, str) else "UNKNOWN"

    estimated_rank_val = summary.get("estimated_rank", "N/A")
    estimated_rank_str = str(estimated_rank_val)

    key_findings_val = summary.get("key_findings", [])
    key_findings: list[str] = (
        [str(x) for x in key_findings_val] if isinstance(key_findings_val, list) else []
    )

    recommendations_val = summary.get("recommendations", [])
    recommendations: list[str] = (
        [str(x) for x in recommendations_val] if isinstance(recommendations_val, list) else []
    )

    print("\n" + "=" * 70)
    print("📊 REALM-Bench Results Summary")
    print("=" * 70)

    print("\n🎯 Overall Performance:")
    print(f"   Status: {status_str}")
    print(f"   Success Rate: {metrics.overall_success_rate:.1%}")
    print(f"   Total Tasks: {metrics.total_tasks}")
    print(f"   Passed: {metrics.passed_tasks}")
    print(f"   Failed: {metrics.failed_tasks}")
    print(f"   Estimated Rank: #{estimated_rank_str}")

    print("\n📈 Planning Metrics:")
    print(f"   Plan Quality: {metrics.avg_plan_quality:.1%}")
    print(f"   Goal Achievement: {metrics.avg_goal_achievement:.1%}")
    print(f"   Efficiency: {metrics.avg_efficiency:.1%}")

    print("\n⏱️  Performance:")
    print(f"   Avg Planning Time: {metrics.avg_planning_time_ms:.0f}ms")
    print(f"   Avg Execution Time: {metrics.avg_execution_time_ms:.0f}ms")
    print(f"   Total Duration: {report.metadata.get('duration_seconds', 0):.1f}s")

    print("\n📊 Category Breakdown:")
    for category, data in report.category_breakdown.items():
        rate = data.get('success_rate', 0)
        total = data.get('total', 0)
        passed = data.get('passed', 0)
        print(f"   {category}: {passed:.0f}/{total:.0f} ({rate:.1%})")

    print("\n📌 Key Findings:")
    for finding in key_findings:
        print(f"   • {finding}")

    print("\n💡 Recommendations:")
    for rec in recommendations:
        print(f"   • {rec}")

    print("\n" + "=" * 70)


async def run_benchmark(
    config: REALMConfig,
    verbose: bool = False,
    enable_trajectory_logging: bool = True,
    provider: str = "eliza",
) -> REALMReport:
    """Run the benchmark via the eliza TS bridge."""
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    eliza_server = None
    if provider in {"mock", "local"}:
        runner = REALMRunner(
            config,
            use_mock=True,
            enable_trajectory_logging=enable_trajectory_logging,
        )
    else:
        from eliza_adapter import ElizaREALMAgent, ElizaServerManager

        if not os.environ.get("ELIZA_BENCH_URL"):
            eliza_server = ElizaServerManager()
            eliza_server.start()
            client = eliza_server.client
        else:
            from eliza_adapter import ElizaClient

            client = ElizaClient()
            client.wait_until_ready(timeout=120)

        agent = ElizaREALMAgent(
            client=client,
            max_steps=config.max_steps,
            execution_model=config.execution_model,
            enable_adaptation=config.enable_adaptation,
        )

        runner = REALMRunner(
            config,
            agent=agent,
            enable_trajectory_logging=enable_trajectory_logging,
        )

    try:
        report = await runner.run_benchmark()
    finally:
        close = getattr(runner.agent, "close", None)
        if callable(close):
            await close()
        if eliza_server is not None:
            eliza_server.stop()

    return report


def main() -> int:
    """Main entry point."""
    args = parse_args()

    # Load root .env if present (quietly)
    load_root_env()

    if not args.json:
        print_banner()

    # Check environment
    if args.check_env:
        check_environment()
        return 0

    # Show leaderboard only
    if args.leaderboard:
        print_leaderboard()
        return 0

    # Create config
    config = create_config(args)

    if not args.json:
        print("📋 Configuration:")
        print(f"   Data Path: {config.data_path}")
        print(f"   Output Dir: {config.output_dir}")
        print(f"   Categories: {[c.value for c in config.categories] if config.categories else 'all'}")
        print(f"   Max Tasks: {config.max_tasks_per_category or 'unlimited'}")
        print(f"   Max Steps: {config.max_steps}")
        print(f"   Execution Model: {config.execution_model.value}")
        print(f"   Adaptation: {'enabled' if config.enable_adaptation else 'disabled'}")
        print()
        print("🚀 Starting benchmark...\n")

    try:
        enable_traj_logging = not args.no_trajectory_logging
        provider = "mock" if args.mock else args.provider
        report = asyncio.run(run_benchmark(
            config,
            args.verbose,
            enable_trajectory_logging=enable_traj_logging,
            provider=provider,
        ))

        if args.json:
            # Output as JSON — agent isn't used here, just need a runner instance
            # to call _report_to_dict
            from benchmarks.realm.runner import REALMRunner
            runner = REALMRunner(config, agent=object())
            results_dict = runner._report_to_dict(report)
            print(json.dumps(results_dict, indent=2, default=str))
        else:
            print_results_summary(report)

            if not args.no_save:
                print(f"\n📁 Full results saved to: {config.output_dir}/")

            print("\n✅ Benchmark completed successfully!")

            # Show leaderboard comparison
            print("\n" + "-" * 70)
            print("📊 Leaderboard Comparison:")
            our_score = report.metrics.overall_success_rate * 100
            for model, data in sorted(
                report.comparison_to_leaderboard.items(),
                key=lambda x: x[1].get("their_score", 0),
                reverse=True,
            )[:5]:
                their = data.get("their_score", 0)
                diff = our_score - their
                indicator = "🟢" if diff > 0 else "🔴" if diff < 0 else "🟡"
                print(f"   {indicator} vs {model}: {diff:+.1f}%")

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

        return 1


if __name__ == "__main__":
    sys.exit(main())
