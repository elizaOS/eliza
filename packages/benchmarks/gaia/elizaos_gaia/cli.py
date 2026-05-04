"""
GAIA Benchmark CLI

Command-line interface for running GAIA benchmarks.

Every run goes through the elizaOS TypeScript benchmark bridge
(``packages/app-core/src/benchmark/server.ts``); the legacy Python
``AgentRuntime`` path has been removed. The bridge owns its own model
provider selection through the runtime config — ``--provider`` /
``--model`` are forwarded to the bridge as hints / labels for output
naming.
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from elizaos_gaia.providers import (
    PRESETS,
    ModelProvider,
    list_models,
)
from elizaos_gaia.runner import GAIARunner, run_quick_test
from elizaos_gaia.types import GAIAConfig, GAIALevel


def load_dotenv(
    start_dir: Path | None = None,
    *,
    filename: str = ".env",
) -> Path | None:
    """
    Load environment variables from a `.env` file if present.

    This is intentionally lightweight (no extra dependency). It:
    - Walks upward from `start_dir` (or CWD) to find `.env`
    - Parses KEY=VALUE lines (ignores comments/blank lines)
    - Does **not** overwrite existing environment variables

    Returns:
        The path to the loaded `.env`, or None if no file was found.
    """
    current = start_dir or Path.cwd()
    for candidate_dir in [current, *current.parents]:
        env_path = candidate_dir / filename
        if not env_path.exists():
            continue

        try:
            raw = env_path.read_text(encoding="utf-8")
        except OSError:
            return None

        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :].strip()
            if "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if not key:
                continue
            os.environ.setdefault(key, value)

        return env_path

    return None


def setup_logging(verbose: bool = False, quiet: bool = False) -> None:
    """Configure logging based on verbosity."""
    if quiet:
        level = logging.WARNING
    elif verbose:
        level = logging.DEBUG
    else:
        level = logging.INFO

    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    provider_choices = [p.value for p in ModelProvider]
    preset_choices = list(PRESETS.keys())

    parser = argparse.ArgumentParser(
        prog="gaia-benchmark",
        description="GAIA Benchmark for elizaOS - Evaluate AI assistants on real-world tasks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run quick test (sample dataset, default model)
  gaia-benchmark --quick-test

  # Run with specific model (forwarded to the bridge as a hint)
  gaia-benchmark --model claude-sonnet-4-6

  # Run full benchmark on validation set
  gaia-benchmark --split validation

  # List available models and presets
  gaia-benchmark --list-models
  gaia-benchmark --list-presets
""",
    )

    # List commands
    parser.add_argument("--list-models", action="store_true", help="List available models for each provider")
    parser.add_argument("--list-presets", action="store_true", help="List available model presets")

    # Basic options
    parser.add_argument("--quick-test", action="store_true", help="Run quick test with 5 questions")
    parser.add_argument(
        "--split",
        choices=["validation", "test"],
        default="validation",
        help="Dataset split to use (default: validation)",
    )
    parser.add_argument(
        "--dataset",
        choices=["gaia", "sample", "jsonl"],
        default="gaia",
        help="Dataset source: 'gaia' (HuggingFace, gated), 'sample' (built-in), or 'jsonl' (local file via --dataset-path)",
    )
    parser.add_argument("--dataset-path", type=str, default=None, help="Path to local dataset JSONL file (required when --dataset jsonl)")
    parser.add_argument("--levels", type=str, default=None, help="Comma-separated list of levels to run (e.g., '1,2')")
    parser.add_argument("--max-questions", type=int, default=None, help="Maximum number of questions to run")

    # Output options
    parser.add_argument("--output", "-o", type=str, default="./benchmark_results/gaia", help="Output directory for results")
    parser.add_argument("--no-report", action="store_true", help="Skip generating markdown report")
    parser.add_argument("--no-leaderboard", action="store_true", help="Skip leaderboard comparison")

    # Provider/Model hints (forwarded to the bridge as labels for output naming)
    parser.add_argument(
        "--provider",
        "-p",
        type=str,
        choices=provider_choices,
        default=None,
        help="Provider hint (forwarded to the bridge for output naming).",
    )
    parser.add_argument("--model", "-m", type=str, default="llama-3.1-8b-instant", help="Model name (default: llama-3.1-8b-instant)")
    parser.add_argument("--preset", type=str, choices=preset_choices, default=None, help="Use a predefined model preset")
    parser.add_argument("--temperature", type=float, default=0.0, help="Temperature for model (default: 0.0)")
    parser.add_argument("--max-tokens", type=int, default=4096, help="Max tokens for model response (default: 4096)")
    parser.add_argument("--api-base", type=str, default=None, help="Override API base URL (for custom endpoints)")

    # Tool options
    parser.add_argument("--disable-web-search", action="store_true", help="Disable web search tool")
    parser.add_argument("--disable-web-browse", action="store_true", help="Disable web browsing tool")
    parser.add_argument("--disable-code-execution", action="store_true", help="Disable code execution tool")
    parser.add_argument("--use-docker", action="store_true", help="Run code in Docker sandbox")

    # Execution options
    parser.add_argument("--timeout", type=int, default=300000, help="Timeout per question in ms (default: 300000)")
    parser.add_argument("--max-iterations", type=int, default=15, help="Max agent iterations per question (default: 15)")

    # Verbosity
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose output")
    parser.add_argument("--quiet", "-q", action="store_true", help="Suppress non-essential output")

    # HuggingFace token
    parser.add_argument("--hf-token", type=str, default=None, help="HuggingFace token (or set HF_TOKEN env var)")

    return parser.parse_args()


def build_config(args: argparse.Namespace) -> GAIAConfig:
    """Build GAIAConfig from command-line arguments."""
    levels: list[GAIALevel] | None = None
    if args.levels:
        level_strs = args.levels.split(",")
        levels = [GAIALevel(level.strip()) for level in level_strs]

    model_name = args.model
    provider = args.provider

    if args.preset:
        preset = PRESETS.get(args.preset)
        if preset:
            model_name = preset.model_name
            provider = preset.provider.value

    return GAIAConfig(
        split=args.split,
        dataset_source=args.dataset,
        dataset_path=args.dataset_path,
        levels=levels,
        max_questions=args.max_questions,
        output_dir=args.output,
        generate_report=not args.no_report,
        compare_leaderboard=not args.no_leaderboard,
        save_detailed_logs=True,
        save_trajectories=True,
        include_model_in_output=True,
        model_name=model_name,
        provider=provider,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        api_base=args.api_base,
        enable_web_search=not args.disable_web_search,
        enable_web_browse=not args.disable_web_browse,
        enable_code_execution=not args.disable_code_execution,
        code_execution_sandbox=args.use_docker,
        web_search_api_key=os.getenv("SERPER_API_KEY"),
        timeout_per_question_ms=args.timeout,
        max_iterations=args.max_iterations,
    )


def handle_list_commands(args: argparse.Namespace) -> bool:
    """Handle list commands. Returns True if a list command was handled."""
    if args.list_models:
        print("\n=== Available Models by Provider ===\n")
        for provider, models in list_models().items():
            print(f"{provider.upper()}:")
            for model in models:
                print(f"  - {model}")
            print()
        return True

    if args.list_presets:
        print("\n=== Available Presets ===\n")
        for name, config in PRESETS.items():
            print(f"  {name:20} -> {config.provider.value}/{config.model_name}")
        print()
        return True

    return False


async def run_benchmark_async(args: argparse.Namespace) -> int:
    """Run the benchmark asynchronously through the elizaOS TS bridge."""
    if handle_list_commands(args):
        return 0

    config = build_config(args)
    if args.quick_test and not config.max_questions:
        config.max_questions = args.max_questions or 5

    hf_token = args.hf_token or os.getenv("HF_TOKEN")

    print("\nProvider: eliza (elizaOS TypeScript benchmark bridge)")

    server_mgr = None
    spawn_server = not os.environ.get("ELIZA_BENCH_URL")
    try:
        if spawn_server:
            from eliza_adapter.server_manager import ElizaServerManager

            server_mgr = ElizaServerManager()
            server_mgr.start()
            os.environ["ELIZA_BENCH_TOKEN"] = server_mgr.token
            os.environ.setdefault("ELIZA_BENCH_URL", f"http://localhost:{server_mgr.port}")
            print(f"Eliza bench server ready on port {server_mgr.port}")
        else:
            from eliza_adapter.client import ElizaClient

            ElizaClient().wait_until_ready(timeout=120)

        if args.quick_test:
            results = await run_quick_test(config, num_questions=config.max_questions or 5, hf_token=hf_token)
        else:
            runner = GAIARunner(config)
            results = await runner.run_benchmark(hf_token=hf_token)

        print(f"\n=== Results: eliza/{config.model_name or 'eliza-ts-bridge'} ===")
        print(f"Overall Accuracy: {results.metrics.overall_accuracy:.1%}")
        print(
            f"Correct: {results.metrics.correct_answers}/{results.metrics.total_questions}"
        )

        return 0 if results.metrics.overall_accuracy >= 0.3 else 2
    except KeyboardInterrupt:
        print("\nBenchmark interrupted by user")
        return 130
    except Exception as e:
        print(f"\nBenchmark failed: {e}")
        if args.verbose:
            import traceback

            traceback.print_exc()
        return 1
    finally:
        if server_mgr is not None:
            server_mgr.stop()


def main() -> None:
    """Main entry point."""
    _ = load_dotenv()

    args = parse_args()
    setup_logging(verbose=args.verbose, quiet=args.quiet)

    exit_code = asyncio.run(run_benchmark_async(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
