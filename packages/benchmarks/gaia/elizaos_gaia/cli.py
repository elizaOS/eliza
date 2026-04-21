"""
GAIA Benchmark CLI

Command-line interface for running GAIA benchmarks.

Supports multiple LLM providers:
- Groq (default): llama-3.1-8b-instant
- OpenAI: gpt-5, gpt-5-mini, o1-preview
- Anthropic: claude-3-5-sonnet, claude-3-5-haiku
- Ollama: local models
- LocalAI: OpenAI-compatible local
- OpenRouter: multiple providers
- Google: gemini models
- XAI: grok models
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
    get_available_providers,
    list_models,
)
from elizaos_gaia.orchestrator.runner import OrchestratedGAIARunner
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
            # Allow `export KEY=VALUE`
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
    # Build provider choices
    provider_choices = [p.value for p in ModelProvider]
    preset_choices = list(PRESETS.keys())

    parser = argparse.ArgumentParser(
        prog="gaia-benchmark",
        description="GAIA Benchmark for ElizaOS - Evaluate AI assistants on real-world tasks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run quick test with default model (Groq llama-3.1-8b-instant)
  gaia-benchmark --quick-test

  # Run with specific provider/model
  gaia-benchmark --provider groq --model llama-3.3-70b-versatile
  gaia-benchmark --provider openai --model gpt-5
  gaia-benchmark --provider anthropic --model claude-3-5-sonnet-20241022

  # Run with preset (predefined model configurations)
  gaia-benchmark --preset groq-fast
  gaia-benchmark --preset qwen-32b
  gaia-benchmark --preset openai-reasoning

  # Run full benchmark on validation set
  gaia-benchmark --split validation

  # List available models and presets
  gaia-benchmark --list-models
  gaia-benchmark --list-presets

Supported Providers:
  groq        Groq Cloud (fastest) - llama-3.1-8b-instant, llama-3.3-70b
  openai      OpenAI - gpt-5, gpt-5-mini, o1-preview
  anthropic   Anthropic - claude-3-5-sonnet, claude-3-5-haiku
  ollama      Ollama (local) - llama3.2, qwen2.5, mistral
  localai     LocalAI (local) - OpenAI-compatible
  openrouter  OpenRouter - many models (qwen, llama, deepseek)
  google      Google GenAI - gemini-2.0-flash, gemini-1.5-pro
  xai         XAI - grok-2

Environment Variables:
  GROQ_API_KEY        Groq API key (default provider)
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key
  OPENROUTER_API_KEY  OpenRouter API key
  GOOGLE_API_KEY      Google GenAI API key
  XAI_API_KEY         XAI API key
  SERPER_API_KEY      Serper API key for web search (optional)
  HF_TOKEN            HuggingFace token for dataset access (optional)
""",
    )

    # List commands
    parser.add_argument(
        "--list-models",
        action="store_true",
        help="List available models for each provider",
    )
    parser.add_argument(
        "--list-presets",
        action="store_true",
        help="List available model presets",
    )
    parser.add_argument(
        "--list-providers",
        action="store_true",
        help="List providers with available API keys",
    )

    # Basic options
    parser.add_argument(
        "--quick-test",
        action="store_true",
        help="Run quick test with 5 questions",
    )
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
        help=(
            "Dataset source: 'gaia' (HuggingFace, gated), 'sample' (built-in), "
            "or 'jsonl' (local file via --dataset-path)"
        ),
    )
    parser.add_argument(
        "--dataset-path",
        type=str,
        default=None,
        help="Path to local dataset JSONL file (required when --dataset jsonl)",
    )
    parser.add_argument(
        "--levels",
        type=str,
        default=None,
        help="Comma-separated list of levels to run (e.g., '1,2')",
    )
    parser.add_argument(
        "--max-questions",
        type=int,
        default=None,
        help="Maximum number of questions to run",
    )

    # Output options
    parser.add_argument(
        "--output", "-o",
        type=str,
        default="./benchmark_results/gaia",
        help="Output directory for results (default: ./benchmark_results/gaia)",
    )
    parser.add_argument(
        "--no-report",
        action="store_true",
        help="Skip generating markdown report",
    )
    parser.add_argument(
        "--no-leaderboard",
        action="store_true",
        help="Skip leaderboard comparison",
    )

    # Provider/Model options
    parser.add_argument(
        "--provider", "-p",
        type=str,
        choices=provider_choices,
        default=None,
        help="LLM provider (default: auto-detect based on available API keys)",
    )
    parser.add_argument(
        "--model", "-m",
        type=str,
        default="llama-3.1-8b-instant",
        help="Model name (default: llama-3.1-8b-instant)",
    )
    parser.add_argument(
        "--preset",
        type=str,
        choices=preset_choices,
        default=None,
        help="Use a predefined model preset",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Temperature for model (default: 0.0)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=4096,
        help="Max tokens for model response (default: 4096)",
    )
    parser.add_argument(
        "--api-base",
        type=str,
        default=None,
        help="Override API base URL (for custom endpoints)",
    )

    # Tool options
    parser.add_argument(
        "--disable-web-search",
        action="store_true",
        help="Disable web search tool",
    )
    parser.add_argument(
        "--disable-web-browse",
        action="store_true",
        help="Disable web browsing tool",
    )
    parser.add_argument(
        "--disable-code-execution",
        action="store_true",
        help="Disable code execution tool",
    )
    parser.add_argument(
        "--use-docker",
        action="store_true",
        help="Run code in Docker sandbox",
    )

    # Execution options
    parser.add_argument(
        "--timeout",
        type=int,
        default=300000,
        help="Timeout per question in ms (default: 300000)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=15,
        help="Max agent iterations per question (default: 15)",
    )

    parser.add_argument(
        "--orchestrated",
        action="store_true",
        help="Run GAIA through orchestrator/subagent lifecycle",
    )
    parser.add_argument(
        "--execution-mode",
        choices=["orchestrated", "direct_shell"],
        default="orchestrated",
        help="Control-plane mode for orchestrated GAIA run",
    )
    parser.add_argument(
        "--providers",
        nargs="+",
        choices=["claude-code", "swe-agent", "codex"],
        default=None,
        help="Provider set for orchestrated mode (default: all)",
    )
    parser.add_argument(
        "--orchestrator-model",
        type=str,
        default="gpt-4o",
        help="Model name used for orchestrator planning prompts",
    )
    parser.add_argument(
        "--matrix",
        action="store_true",
        help="Run full 2x3 matrix across direct_shell/orchestrated and all selected providers",
    )
    parser.add_argument(
        "--required-capabilities",
        type=str,
        default="",
        help="Comma-separated required capability IDs",
    )
    parser.add_argument(
        "--strict-capabilities",
        action="store_true",
        help="Fail each run when required capabilities are missing",
    )

    # Verbosity
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose output",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress non-essential output",
    )

    # HuggingFace token
    parser.add_argument(
        "--hf-token",
        type=str,
        default=None,
        help="HuggingFace token (or set HF_TOKEN env var)",
    )

    return parser.parse_args()


def build_config(args: argparse.Namespace) -> GAIAConfig:
    """Build GAIAConfig from command-line arguments."""
    # Parse levels
    levels: list[GAIALevel] | None = None
    if args.levels:
        level_strs = args.levels.split(",")
        levels = [GAIALevel(level.strip()) for level in level_strs]

    # Handle preset
    model_name = args.model
    provider = args.provider

    if args.preset:
        preset = PRESETS.get(args.preset)
        if preset:
            model_name = preset.model_name
            provider = preset.provider.value

    return GAIAConfig(
        # Dataset
        split=args.split,
        dataset_source=args.dataset,
        dataset_path=args.dataset_path,
        levels=levels,
        max_questions=args.max_questions,

        # Output
        output_dir=args.output,
        generate_report=not args.no_report,
        compare_leaderboard=not args.no_leaderboard,
        save_detailed_logs=True,
        save_trajectories=True,
        include_model_in_output=True,  # Prevents overwriting results

        # Model/Provider
        model_name=model_name,
        provider=provider,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        api_base=args.api_base,

        # Tools
        enable_web_search=not args.disable_web_search,
        enable_web_browse=not args.disable_web_browse,
        enable_code_execution=not args.disable_code_execution,
        code_execution_sandbox=args.use_docker,
        web_search_api_key=os.getenv("SERPER_API_KEY"),

        # Execution
        timeout_per_question_ms=args.timeout,
        max_iterations=args.max_iterations,
        orchestrated=bool(args.orchestrated or args.matrix),
        execution_mode=str(args.execution_mode),
        matrix=bool(args.matrix),
        orchestrator_model=str(args.orchestrator_model),
        provider_set=list(args.providers) if args.providers else ["claude-code", "swe-agent", "codex"],
        required_capabilities=[
            item.strip()
            for item in str(args.required_capabilities).split(",")
            if item.strip()
        ],
        strict_capabilities=bool(args.strict_capabilities),
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

    if args.list_providers:
        available = get_available_providers()
        print("\n=== Providers with Available API Keys ===\n")
        for provider in ModelProvider:
            status = "✓" if provider.value in available else "✗"
            print(f"  {status} {provider.value}")
        print("\nSet environment variables to enable more providers.")
        return True

    return False


async def run_benchmark_async(args: argparse.Namespace) -> int:
    """Run the benchmark asynchronously."""
    # Handle list commands first
    if handle_list_commands(args):
        return 0

    # Check for available API keys
    available_providers = get_available_providers()

    if not available_providers:
        print("Error: No API keys found for any provider.")
        print("\nSet one of the following environment variables:")
        print("  export GROQ_API_KEY=your_key        # Recommended (fastest)")
        print("  export OPENAI_API_KEY=your_key")
        print("  export ANTHROPIC_API_KEY=your_key")
        print("  export OPENROUTER_API_KEY=your_key")
        print("  export GOOGLE_API_KEY=your_key")
        print("  export XAI_API_KEY=your_key")
        print("\nOr use Ollama for local models (no key required):")
        print("  gaia-benchmark --provider ollama --model llama3.2:latest")
        return 1

    # Validate provider selection
    if args.provider and args.provider not in available_providers:
        if args.provider != "ollama":  # Ollama doesn't need API key
            print(f"Error: {args.provider.upper()} API key not found.")
            print(f"Set the {args.provider.upper()}_API_KEY environment variable.")
            return 1

    try:
        hf_token = args.hf_token or os.getenv("HF_TOKEN")

        if args.orchestrated or args.matrix:
            config = build_config(args)
            if args.quick_test and not config.max_questions:
                config.max_questions = 5
            print(
                "Running orchestrated GAIA benchmark "
                f"({config.execution_mode}, matrix={config.matrix}) "
                f"with providers={','.join(config.provider_set)}..."
            )
            runner = OrchestratedGAIARunner(config)
            report = await runner.run_benchmark(hf_token=hf_token)
            print("\n=== Orchestrated GAIA Results ===")
            print(f"Overall Accuracy: {report.overall_accuracy:.1%}")
            for provider_key, summary in report.provider_summaries.items():
                print(
                    f"- {provider_key}: {summary.accuracy:.1%} "
                    f"({summary.correct_answers}/{summary.total_questions})"
                )
            return 0 if report.overall_accuracy >= 0.3 else 2

        if args.quick_test:
            # Use preset or defaults for quick test
            model_name = args.model
            provider = args.provider

            if args.preset:
                preset = PRESETS.get(args.preset)
                if preset:
                    model_name = preset.model_name
                    provider = preset.provider.value

            num_q = args.max_questions or 5
            print(f"Running quick test ({num_q} questions) with {provider or 'auto'}/{model_name}...")
            config = GAIAConfig(
                split=args.split,
                dataset_source=args.dataset,
                dataset_path=args.dataset_path,
                max_questions=args.max_questions or 5,
                output_dir=args.output,
                model_name=model_name,
                provider=provider,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                include_model_in_output=True,
                generate_report=not args.no_report,
                compare_leaderboard=not args.no_leaderboard,
            )
            results = await run_quick_test(config, num_questions=num_q, hf_token=hf_token)
        else:
            config = build_config(args)
            print(f"Running GAIA benchmark with {config.provider or 'auto'}/{config.model_name}...")
            runner = GAIARunner(config)
            results = await runner.run_benchmark(hf_token=hf_token)

        # Print summary
        print(f"\n=== Results: {config.provider or 'auto'}/{config.model_name} ===")
        print(f"Overall Accuracy: {results.metrics.overall_accuracy:.1%}")
        print(f"Correct: {results.metrics.correct_answers}/{results.metrics.total_questions}")

        # Return exit code based on results
        if results.metrics.overall_accuracy >= 0.3:
            return 0  # Success threshold
        else:
            return 2  # Below threshold but completed

    except KeyboardInterrupt:
        print("\nBenchmark interrupted by user")
        return 130
    except Exception as e:
        print(f"\nBenchmark failed: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


def main() -> None:
    """Main entry point."""
    # Load `.env` from repo root (if present) so users can simply drop keys in `.env`.
    _ = load_dotenv()

    args = parse_args()
    setup_logging(verbose=args.verbose, quiet=args.quiet)

    exit_code = asyncio.run(run_benchmark_async(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
