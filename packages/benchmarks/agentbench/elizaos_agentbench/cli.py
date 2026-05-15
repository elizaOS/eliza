"""
Command-line interface for AgentBench.
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from elizaos_agentbench import upstream_loader
from elizaos_agentbench.mock_runtime import SmartMockRuntime
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchDataMode,
    AgentBenchEnvironment,
    BenchmarkSplit,
)

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
        description="AgentBench benchmark",
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
        "--split",
        choices=["dev", "test"],
        default="test",
        help="AgentBench split to run",
    )
    run_parser.add_argument(
        "--data-mode",
        choices=["auto", "fixture", "full"],
        default="auto",
        help="Task data mode: auto uses full data when present and compact fixtures otherwise",
    )
    run_parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Allow enabled environments to load zero tasks",
    )
    run_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Allow empty task sets for setup checks",
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
        choices=["mock", "bridge", "elizaos", "eliza", "hermes", "openclaw"],
        default="mock",
        help=(
            "Runtime/harness to use: mock for testing, bridge/eliza/elizaos "
            "for Eliza TS evaluation, or hermes/openclaw for adapter clients"
        ),
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

    data_parser = subparsers.add_parser("data", help="Fetch or verify upstream AgentBench data")
    data_subparsers = data_parser.add_subparsers(dest="data_command", help="Data commands")
    fetch_parser = data_subparsers.add_parser("fetch", help="Fetch upstream AgentBench data")
    fetch_parser.add_argument("--no-verify", action="store_true", help="Skip post-fetch verification")
    _ = data_subparsers.add_parser("verify", help="Verify upstream AgentBench data")

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
        split=BenchmarkSplit(args.split),
        data_mode=AgentBenchDataMode(args.data_mode),
        allow_empty_tasks=args.allow_empty,
        dry_run=args.dry_run,
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

        if args.max_tasks is not None:
            env_config.max_tasks = args.max_tasks

        if env == AgentBenchEnvironment.OS:
            env_config.additional_settings["use_docker"] = not args.no_docker

    # Create runtime
    runtime = None
    bridge_manager = None
    runtime_name = str(args.runtime).strip().lower()
    if runtime_name == "eliza":
        runtime_name = "bridge"
    enabled_configs = [
        config.get_env_config(env)
        for env in AgentBenchEnvironment
        if config.get_env_config(env).enabled
    ]
    zero_task_dry_run = bool(
        config.dry_run
        and enabled_configs
        and all(env_config.max_tasks == 0 for env_config in enabled_configs)
    )
    if zero_task_dry_run:
        harness_label = "eliza" if runtime_name in {"bridge", "elizaos"} else runtime_name
        if harness_label in {"eliza", "hermes", "openclaw"}:
            os.environ["BENCHMARK_HARNESS"] = harness_label
            os.environ["ELIZA_BENCH_HARNESS"] = harness_label
        logger.info(
            "Using deterministic mock runtime for zero-task %s dry-run preflight",
            harness_label,
        )
        runtime = SmartMockRuntime()
    elif runtime_name in {"bridge", "elizaos"}:
        from eliza_adapter import ElizaServerManager
        from eliza_adapter.agentbench import ElizaAgentHarness

        _load_dotenv()
        os.environ["BENCHMARK_HARNESS"] = "eliza"
        os.environ["ELIZA_BENCH_HARNESS"] = "eliza"
        bridge_manager = ElizaServerManager()
        bridge_manager.start()
        runtime = SmartMockRuntime()
        runtime._app_harness = ElizaAgentHarness(bridge_manager.client)  # type: ignore[attr-defined]
        logger.info("Using Eliza TypeScript bridge")
    elif runtime_name in {"hermes", "openclaw"}:
        from elizaos_agentbench.agent_fn_harness import AgentFnHarness

        _load_dotenv()
        os.environ["BENCHMARK_HARNESS"] = runtime_name
        os.environ["ELIZA_BENCH_HARNESS"] = runtime_name
        model_name = (
            os.environ.get("BENCHMARK_MODEL_NAME")
            or os.environ.get("MODEL_NAME")
            or os.environ.get("CEREBRAS_MODEL")
            or "gpt-oss-120b"
        )
        if runtime_name == "hermes":
            from hermes_adapter.agentbench import build_agentbench_agent_fn
        else:
            from openclaw_adapter.agentbench import build_agentbench_agent_fn

        runtime = SmartMockRuntime()
        runtime._app_harness = AgentFnHarness(  # type: ignore[attr-defined]
            build_agentbench_agent_fn(model_name=model_name),
            harness=runtime_name,
        )
        logger.info("Using %s AgentBench adapter client", runtime_name)
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

        if config.dry_run and report.total_tasks == 0:
            return 0
        return 0 if report.overall_success_rate > 0.3 else 1

    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        return 1
    finally:
        if bridge_manager is not None:
            bridge_manager.stop()


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


def run_data_command(args: argparse.Namespace) -> int:
    """Run explicit upstream data management commands."""
    try:
        if args.data_command == "fetch":
            path = upstream_loader.fetch_upstream_data(verify=not args.no_verify)
            print(f"Fetched AgentBench upstream data to: {path}")
            return 0
        if args.data_command == "verify":
            status = upstream_loader.verify_upstream_data()
            print(f"Verified AgentBench upstream data at: {upstream_loader.UPSTREAM_DATA}")
            print(f"Checked {len(status)} required paths.")
            return 0
        print("Specify a data command: fetch or verify")
        return 1
    except Exception as e:
        logger.error(f"Data command failed: {e}")
        return 1


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
    elif args.command == "data":
        sys.exit(run_data_command(args))
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
