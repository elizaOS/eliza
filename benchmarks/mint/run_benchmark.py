#!/usr/bin/env python3
"""
MINT Benchmark CLI Runner

Run the MINT benchmark evaluation on ElizaOS Python runtime.

Usage:
    python run_benchmark.py [options]

Examples:
    # Run full benchmark with default settings
    python run_benchmark.py

    # Run quick test with limited tasks
    python run_benchmark.py --max-tasks 2 --no-ablation

    # Run specific categories only
    python run_benchmark.py --categories reasoning coding

    # Run without Docker (local execution)
    python run_benchmark.py --no-docker
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

# Add paths for imports
benchmark_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(benchmark_root))
sys.path.insert(0, str(benchmark_root / "packages" / "python"))
# Add local plugin paths for optional runtime-backed runs
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-openai" / "python"))
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-vercel-ai-gateway" / "python"))
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-xai" / "python"))
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-eliza-classic" / "python"))
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-sql" / "python"))
sys.path.insert(0, str(benchmark_root / "plugins" / "plugin-trajectory-logger" / "python"))

# Now we can import
from benchmarks.mint.types import MINTCategory, MINTConfig
from benchmarks.mint.runner import MINTRunner


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler()],
    )


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run MINT benchmark on ElizaOS Python runtime",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Model/runtime selection
    parser.add_argument(
        "--provider",
        choices=["mock", "eliza-classic", "openai", "gateway", "xai"],
        default="mock",
        help="Model provider to use (default: mock)",
    )
    parser.add_argument(
        "--dotenv",
        type=str,
        default=None,
        help="Optional path to a .env file to load before running",
    )

    # Task selection
    parser.add_argument(
        "--categories",
        nargs="+",
        choices=["reasoning", "coding", "decision_making", "information_seeking"],
        help="Categories to evaluate (default: all)",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum tasks per category (default: all)",
    )

    # Execution settings
    parser.add_argument(
        "--max-turns",
        type=int,
        default=5,
        help="Maximum turns per task (default: 5)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Timeout per task in seconds (default: 120)",
    )
    parser.add_argument(
        "--no-docker",
        action="store_true",
        help="Run code locally instead of in Docker",
    )

    # Feature flags
    parser.add_argument(
        "--no-tools",
        action="store_true",
        help="Disable tool (code) execution",
    )
    parser.add_argument(
        "--no-feedback",
        action="store_true",
        help="Disable feedback generation",
    )
    parser.add_argument(
        "--no-ablation",
        action="store_true",
        help="Skip ablation study (just run full config)",
    )

    # Output
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./benchmark_results/mint",
        help="Output directory for results (default: ./benchmark_results/mint)",
    )
    parser.add_argument(
        "--no-report",
        action="store_true",
        help="Don't generate markdown report",
    )
    parser.add_argument(
        "--save-trajectories",
        action="store_true",
        help="Save detailed trajectories to file",
    )
    parser.add_argument(
        "--llm-feedback",
        action="store_true",
        help="Generate feedback using the selected model provider (costly; default: rule-based)",
    )

    parser.add_argument(
        "--no-trajectory-logging",
        action="store_true",
        help="Disable elizaOS trajectory logging export (enabled by default for runtime providers)",
    )
    parser.add_argument(
        "--trajectory-dataset",
        type=str,
        default="mint-benchmark",
        help="Dataset name used when exporting ART / GRPO trajectories",
    )

    # Misc
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


def create_config(args: argparse.Namespace) -> MINTConfig:
    """Create benchmark configuration from arguments."""
    categories = None
    if args.categories:
        categories = [MINTCategory(c) for c in args.categories]

    return MINTConfig(
        output_dir=args.output_dir,
        max_tasks_per_category=args.max_tasks,
        timeout_per_task_ms=args.timeout * 1000,
        max_turns=args.max_turns,
        use_docker=not args.no_docker,
        categories=categories,
        enable_tools=not args.no_tools,
        enable_feedback=not args.no_feedback,
        run_ablation=not args.no_ablation,
        save_detailed_logs=True,
        save_trajectories=args.save_trajectories,
        generate_report=not args.no_report,
        use_llm_feedback=args.llm_feedback,
    )


def _load_dotenv_file(path: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    - Ignores blank lines and comments
    - Supports KEY=VALUE and 'export KEY=VALUE'
    - Does not override existing environment variables
    """
    if not path.exists() or not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        k = key.strip()
        v = value.strip().strip("'").strip('"')
        if not k:
            continue
        if k not in os.environ:
            os.environ[k] = v


async def _create_eliza_runtime(provider: str, verbose: bool, *, enable_trajectory_logging: bool) -> object:
    """Create and initialize an AgentRuntime with the selected model provider plugin."""
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.model import ModelType

    plugins: list[object] = []
    # Ensure a database adapter exists so the canonical message pipeline works end-to-end.
    # This matches examples/chat (TypeScript) + examples/telegram (Python) behavior.
    from elizaos_plugin_sql import sql_plugin

    plugins.append(sql_plugin)

    if provider == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError(
                "OPENAI_API_KEY is not set. Provide it via environment variables or --dotenv."
            )
        from elizaos_plugin_openai import get_openai_plugin

        plugins.append(get_openai_plugin())
    elif provider == "gateway":
        if not (
            os.environ.get("AI_GATEWAY_API_KEY")
            or os.environ.get("AIGATEWAY_API_KEY")
            or os.environ.get("VERCEL_OIDC_TOKEN")
        ):
            raise ValueError(
                "AI_GATEWAY_API_KEY / AIGATEWAY_API_KEY / VERCEL_OIDC_TOKEN is not set. "
                "Provide it via environment variables or --dotenv."
            )
        from elizaos_plugin_gateway.plugin import get_gateway_plugin

        plugins.append(get_gateway_plugin())
    elif provider == "xai":
        if not os.environ.get("XAI_API_KEY"):
            raise ValueError(
                "XAI_API_KEY is not set. Provide it via environment variables or --dotenv."
            )
        from elizaos_plugin_xai.plugin import get_xai_elizaos_plugin

        plugins.append(get_xai_elizaos_plugin())
    elif provider == "eliza-classic":
        from elizaos_plugin_eliza_classic.plugin import get_eliza_classic_plugin

        plugins.append(get_eliza_classic_plugin())
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Optional: enable end-to-end trajectory capture for training/benchmarks.
    if enable_trajectory_logging:
        try:
            from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

            plugins.append(get_trajectory_logger_plugin())
        except Exception:
            # Never fail benchmark startup due to optional logging.
            pass

    # Create a complete Character with all fields for full provider support
    from elizaos.types.agent import StyleConfig

    character = Character(
        name="MINT-Benchmark",
        username="mint_benchmark",
        bio=[
            "An AI assistant specialized in solving benchmark tasks.",
            "Expert in reasoning, coding, decision making, and information retrieval.",
        ],
        system="You are an AI assistant being evaluated on the MINT benchmark. "
        "Solve tasks precisely and provide clear, formatted answers.",
        adjectives=["precise", "analytical", "thorough", "methodical"],
        topics=["mathematics", "coding", "logic", "problem-solving", "data analysis"],
        style=StyleConfig(
            all=["Be concise", "Show reasoning", "Provide clear answers"],
            chat=["Answer format: 'Final answer: X'"],
        ),
    )

    runtime = AgentRuntime(
        character=character,
        plugins=plugins,  # bootstrap plugin will be auto-added during initialize()
        log_level="DEBUG" if verbose else "ERROR",
        check_should_respond=False,  # benchmark mode: always respond
    )
    await runtime.initialize()

    # Validate that the runtime has a text generation handler.
    if not runtime.has_model(ModelType.TEXT_LARGE):
        raise RuntimeError("Runtime is missing a TEXT_LARGE model handler after initialization")

    return runtime


async def run_benchmark(
    config: MINTConfig,
    provider: str,
    dotenv_path: str | None,
    verbose: bool,
    *,
    enable_trajectory_logging: bool,
    trajectory_dataset: str,
) -> int:
    """Run the benchmark and return exit code."""
    runtime: object | None = None
    try:
        # Load .env (if provided or if repo-root .env exists)
        if dotenv_path:
            _load_dotenv_file(Path(dotenv_path))
        else:
            candidate = benchmark_root / ".env"
            _load_dotenv_file(candidate)

        trajectory_logger_service: object | None = None
        if provider != "mock":
            runtime = await _create_eliza_runtime(
                provider, verbose=verbose, enable_trajectory_logging=enable_trajectory_logging
            )

            if enable_trajectory_logging:
                try:
                    # Prefer the canonical runtime service registered by the plugin.
                    get_service = getattr(runtime, "get_service", None)
                    if callable(get_service):
                        trajectory_logger_service = get_service("trajectory_logger")
                except Exception:
                    trajectory_logger_service = None

        runner = MINTRunner(
            config=config,
            runtime=runtime,
            trajectory_logger_service=trajectory_logger_service,
            trajectory_dataset=trajectory_dataset,
        )
        results = await runner.run_benchmark()

        # Print summary
        print("\n" + "=" * 60)
        print("MINT BENCHMARK RESULTS")
        print("=" * 60)

        summary = results.summary
        print(f"\nStatus: {summary.get('status', 'unknown').upper()}")
        print(f"Best Configuration: {summary.get('best_configuration', 'N/A')}")
        print(f"Best Success Rate: {summary.get('best_success_rate', 'N/A')}")

        print("\nKey Findings:")
        for finding in summary.get("key_findings", []):
            print(f"  • {finding}")

        print("\nRecommendations:")
        for rec in summary.get("recommendations", []):
            print(f"  • {rec}")

        print(f"\nResults saved to: {config.output_dir}")
        print("=" * 60)

        # Return 0 for success, 1 for partial success, 2 for failure
        status = str(summary.get("status", ""))
        if status == "excellent":
            return 0
        elif status in ("good", "moderate"):
            return 1
        else:
            return 2

    except Exception as e:
        logging.error(f"Benchmark failed: {e}")
        raise
    finally:
        if runtime is not None:
            stop = getattr(runtime, "stop", None)
            if callable(stop):
                await stop()


def main() -> int:
    """Main entry point."""
    args = parse_args()
    setup_logging(args.verbose)

    print("=" * 60)
    print("MINT BENCHMARK - ElizaOS Python Runtime Evaluation")
    print("=" * 60)
    print()

    config = create_config(args)

    print("Configuration:")
    print(f"  Provider: {args.provider}")
    print(f"  Categories: {[c.value for c in (config.categories or list(MINTCategory))]}")
    print(f"  Max tasks per category: {config.max_tasks_per_category or 'all'}")
    print(f"  Max turns: {config.max_turns}")
    print(f"  Tools enabled: {config.enable_tools}")
    print(f"  Feedback enabled: {config.enable_feedback}")
    print(f"  LLM feedback: {config.use_llm_feedback}")
    print(f"  Ablation study: {config.run_ablation}")
    print(f"  Docker: {config.use_docker}")
    print()

    return asyncio.run(
        run_benchmark(
            config,
            args.provider,
            args.dotenv,
            args.verbose,
            enable_trajectory_logging=not bool(args.no_trajectory_logging),
            trajectory_dataset=str(args.trajectory_dataset),
        )
    )


if __name__ == "__main__":
    sys.exit(main())
