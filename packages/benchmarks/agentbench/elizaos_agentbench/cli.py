"""
Command-line interface for AgentBench.
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from elizaos_agentbench.types import AgentBenchConfig, AgentBenchEnvironment
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.mock_runtime import SmartMockRuntime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _load_dotenv() -> None:
    """
    Best-effort .env loader (no external dependency).

    - only sets vars not already present in os.environ
    - supports simple KEY=VALUE lines (optionally quoted)
    """

    candidates = [
        Path.cwd() / ".env",
        # repo_root/benchmarks/agentbench/python/elizaos_agentbench/cli.py -> repo_root is parents[4]
        Path(__file__).resolve().parents[4] / ".env",
    ]

    for path in candidates:
        if not path.is_file():
            continue

        try:
            for raw_line in path.read_text().splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                k = key.strip()
                if not k or k in os.environ:
                    continue
                v = value.strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                os.environ[k] = v
        except OSError:
            pass


def create_parser() -> argparse.ArgumentParser:
    """Create command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="AgentBench benchmark for ElizaOS Python",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Run command
    run_parser = subparsers.add_parser("run", help="Run AgentBench benchmark")
    run_parser.add_argument(
        "--env",
        action="append",
        choices=["os", "database", "kg", "webshop", "lateral", "all"],
        default=None,
        help="Environments to run (can specify multiple, default: all implemented)",
    )
    run_parser.add_argument(
        "--output",
        "-o",
        type=str,
        default="./agentbench_results",
        help="Output directory for results",
    )
    run_parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum tasks per environment",
    )
    run_parser.add_argument(
        "--no-docker",
        action="store_true",
        help="Disable Docker for OS environment",
    )
    run_parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    run_parser.add_argument(
        "--runtime",
        type=str,
        choices=["mock", "elizaos"],
        default="mock",
        help="Runtime to use (mock for testing, elizaos for real evaluation)",
    )

    # Report command
    report_parser = subparsers.add_parser("report", help="Generate report from existing results")
    report_parser.add_argument(
        "--input",
        "-i",
        type=str,
        required=True,
        help="Path to results JSON file",
    )
    report_parser.add_argument(
        "--format",
        choices=["md", "json", "html"],
        default="md",
        help="Output format",
    )

    # List command
    _ = subparsers.add_parser("list", help="List available environments and tasks")

    return parser


async def run_benchmark(args: argparse.Namespace) -> int:
    """Run the benchmark with given arguments."""
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Create configuration
    config = AgentBenchConfig(
        output_dir=args.output,
        save_detailed_logs=True,
        enable_metrics=True,
        use_docker=not args.no_docker,
    )

    # Configure environments
    selected_envs = args.env if args.env else ["all"]

    for env in AgentBenchEnvironment:
        env_config = config.get_env_config(env)

        # Check if environment should be enabled
        env_key = {
            AgentBenchEnvironment.OS: "os",
            AgentBenchEnvironment.DATABASE: "database",
            AgentBenchEnvironment.KNOWLEDGE_GRAPH: "kg",
            AgentBenchEnvironment.WEB_SHOPPING: "webshop",
            AgentBenchEnvironment.LATERAL_THINKING: "lateral",
        }.get(env)

        if "all" in selected_envs:
            # Enable implemented environments
            env_config.enabled = env in [
                AgentBenchEnvironment.OS,
                AgentBenchEnvironment.DATABASE,
                AgentBenchEnvironment.KNOWLEDGE_GRAPH,
                AgentBenchEnvironment.WEB_SHOPPING,
                AgentBenchEnvironment.LATERAL_THINKING,
            ]
        else:
            env_config.enabled = env_key in selected_envs

        if args.max_tasks:
            env_config.max_tasks = args.max_tasks

        if env == AgentBenchEnvironment.OS:
            env_config.additional_settings["use_docker"] = not args.no_docker

    # Create runtime
    runtime = None
    if args.runtime == "elizaos":
        try:
            from elizaos.runtime import AgentRuntime
            from elizaos.types.model import LLMMode, ModelType

            _load_dotenv()

            plugins = []
            try:
                from elizaos_plugin_openai import get_openai_plugin

                if os.environ.get("OPENAI_API_KEY"):
                    plugins = [get_openai_plugin()]
                else:
                    logger.warning("OPENAI_API_KEY not set; falling back to deterministic mock runtime")
            except ImportError as e:
                logger.warning(f"OpenAI plugin not available ({e}); falling back to deterministic mock runtime")
            except Exception as e:
                logger.warning(f"Failed to initialize OpenAI plugin ({e}); falling back to deterministic mock runtime")

            if not plugins:
                runtime = SmartMockRuntime()
            else:
                # AgentBench is iterative; default to SMALL to reduce latency/cost.
                runtime = AgentRuntime(plugins=plugins, llm_mode=LLMMode.SMALL)
                await runtime.initialize()
                if not runtime.has_model(ModelType.TEXT_LARGE):
                    logger.warning(
                        "ElizaOS runtime has no TEXT_LARGE model handler; falling back to deterministic mock runtime"
                    )
                    await runtime.stop()
                    runtime = SmartMockRuntime()
                else:
                    logger.info("Using ElizaOS runtime (OpenAI)")
        except ImportError:
            logger.warning("ElizaOS runtime not available, using deterministic mock")
            runtime = SmartMockRuntime()
    else:
        logger.info("Using deterministic mock runtime (harness validation)")
        runtime = SmartMockRuntime()

    # Baseline comparisons are only meaningful for real model runs
    if isinstance(runtime, SmartMockRuntime):
        config.enable_baseline_comparison = False

    # Run benchmark
    logger.info("Starting AgentBench evaluation...")
    logger.info(f"Output directory: {args.output}")

    try:
        runner = AgentBenchRunner(config=config, runtime=runtime)
        report = await runner.run_benchmarks()

        # Print summary
        print("\n" + "=" * 60)
        print("AGENTBENCH EVALUATION COMPLETE")
        print("=" * 60)
        print("\nOverall Results:")
        print(f"  Success Rate: {report.overall_success_rate * 100:.1f}%")
        print(f"  Total Tasks: {report.total_tasks}")
        print(f"  Passed: {report.passed_tasks}")
        print(f"  Failed: {report.failed_tasks}")

        print("\nPer-Environment Results:")
        for env, env_report in report.environment_reports.items():
            status = "✓" if env_report.success_rate > 0.5 else "✗"
            print(
                f"  {status} {env.value}: {env_report.success_rate * 100:.1f}% "
                f"({env_report.passed_tasks}/{env_report.total_tasks})"
            )

        print(f"\nResults saved to: {args.output}")
        print("=" * 60)

        return 0 if report.overall_success_rate > 0.3 else 1

    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        return 1


def list_environments() -> None:
    """List available environments and their status."""
    print("\nAgentBench Environments:")
    print("-" * 60)

    implemented = {
        AgentBenchEnvironment.OS: "✅ Implemented",
        AgentBenchEnvironment.DATABASE: "✅ Implemented",
        AgentBenchEnvironment.KNOWLEDGE_GRAPH: "✅ Implemented",
        AgentBenchEnvironment.CARD_GAME: "🔄 Planned",
        AgentBenchEnvironment.LATERAL_THINKING: "✅ Implemented",
        AgentBenchEnvironment.HOUSEHOLDING: "🔄 Planned",
        AgentBenchEnvironment.WEB_SHOPPING: "✅ Implemented",
        AgentBenchEnvironment.WEB_BROWSING: "🔄 Planned",
    }

    for env in AgentBenchEnvironment:
        status = implemented.get(env, "❓ Unknown")
        print(f"  {env.value:20} {status}")

    print("-" * 60)
    print("\nUse 'agentbench run --env <environment>' to run specific environments")


def main() -> None:
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()

    if args.command == "run":
        exit_code = asyncio.run(run_benchmark(args))
        sys.exit(exit_code)
    elif args.command == "list":
        list_environments()
    elif args.command == "report":
        print("Report generation not yet implemented")
        sys.exit(1)
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
