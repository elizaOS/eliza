"""
BFCL Benchmark CLI

Command-line interface for running the Berkeley Function-Calling Leaderboard benchmark.

Supports multiple model providers:
- Groq (default, with llama-3.1-8b-instant)
- OpenAI, Anthropic, Google GenAI, XAI, OpenRouter, Ollama, LocalAI

Usage:
    python -m benchmarks.bfcl run [OPTIONS]
    python -m benchmarks.bfcl run --sample 50
    python -m benchmarks.bfcl run --provider groq --model llama-3.1-8b-instant
    python -m benchmarks.bfcl run --full --output ./results
    python -m benchmarks.bfcl models  # List available models
"""

import argparse
import asyncio
import logging
import sys

# Load environment variables from .env file at project root
# This must happen before other imports that may use env vars
from dotenv import load_dotenv
load_dotenv()

from benchmarks.bfcl.runner import BFCLRunner  # noqa: E402
from benchmarks.bfcl.types import BFCLCategory, BFCLConfig  # noqa: E402
from benchmarks.bfcl.reporting import print_results  # noqa: E402


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="BFCL Benchmark - Berkeley Function-Calling Leaderboard",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run a quick sample of 50 tests (uses Groq llama-3.1-8b-instant by default)
  python -m benchmarks.bfcl run --sample 50

  # Run with specific provider
  python -m benchmarks.bfcl run --provider openai --sample 50

  # Run with specific model
  python -m benchmarks.bfcl run --model groq/llama-3.3-70b-versatile --sample 50

  # Run full benchmark
  python -m benchmarks.bfcl run --full

  # Run specific categories
  python -m benchmarks.bfcl run --categories simple,multiple,parallel

  # Run in mock mode (for testing)
  python -m benchmarks.bfcl run --mock --sample 10

  # List available models
  python -m benchmarks.bfcl models

Environment Variables:
  BFCL_PROVIDER  - Default provider (groq, openai, anthropic, etc.)
  BFCL_MODEL     - Default model (e.g., groq/llama-3.1-8b-instant)
  GROQ_API_KEY   - Groq API key (recommended default)
  OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Run command
    run_parser = subparsers.add_parser("run", help="Run BFCL benchmark")

    # Model/Provider options
    run_parser.add_argument(
        "--provider",
        type=str,
        choices=["groq", "openai", "anthropic", "google-genai", "openrouter", "xai", "ollama", "local-ai"],
        help="Model provider (default: groq if GROQ_API_KEY set)",
    )
    run_parser.add_argument(
        "--model",
        type=str,
        help="Specific model (e.g., groq/llama-3.1-8b-instant, openai/gpt-5)",
    )

    run_parser.add_argument(
        "--sample",
        type=int,
        help="Run a sample of N tests (default: run all)",
    )
    run_parser.add_argument(
        "--full",
        action="store_true",
        help="Run full benchmark (all tests)",
    )
    run_parser.add_argument(
        "--categories",
        type=str,
        help="Comma-separated list of categories to run",
    )
    run_parser.add_argument(
        "--max-per-category",
        type=int,
        help="Maximum tests per category",
    )
    run_parser.add_argument(
        "--output",
        type=str,
        default="./benchmark_results/bfcl",
        help="Output directory for results",
    )
    run_parser.add_argument(
        "--timeout",
        type=int,
        default=60000,
        help="Timeout per test in milliseconds (default: 60000)",
    )
    run_parser.add_argument(
        "--mock",
        action="store_true",
        help="Use mock agent (for testing infrastructure)",
    )
    run_parser.add_argument(
        "--no-exec",
        action="store_true",
        help="Skip execution evaluation",
    )
    run_parser.add_argument(
        "--no-report",
        action="store_true",
        help="Skip report generation",
    )
    run_parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose output",
    )
    run_parser.add_argument(
        "--local-data",
        type=str,
        help="Path to local BFCL data (instead of HuggingFace)",
    )

    # Models command
    models_parser = subparsers.add_parser("models", help="List available models")
    models_parser.add_argument(
        "--all",
        action="store_true",
        help="Show all supported models (not just available)",
    )

    # Info command
    info_parser = subparsers.add_parser("info", help="Show benchmark information")
    info_parser.add_argument(
        "--baselines",
        action="store_true",
        help="Show leaderboard baselines",
    )
    info_parser.add_argument(
        "--categories",
        action="store_true",
        help="Show available categories",
    )

    return parser.parse_args()


def parse_categories(categories_str: str) -> list[BFCLCategory]:
    """Parse comma-separated category names."""
    categories = []
    for name in categories_str.split(","):
        name = name.strip().lower()
        try:
            categories.append(BFCLCategory(name))
        except ValueError:
            print(f"Warning: Unknown category '{name}', skipping")
    return categories


async def run_benchmark(args: argparse.Namespace) -> int:
    """Run the BFCL benchmark."""
    # Build configuration
    config = BFCLConfig(
        output_dir=args.output,
        timeout_per_test_ms=args.timeout,
        run_exec_eval=not args.no_exec,
        generate_report=not args.no_report,
    )

    # Set categories if specified
    if args.categories:
        config.categories = parse_categories(args.categories)

    # Set max tests per category
    if args.max_per_category:
        config.max_tests_per_category = args.max_per_category

    # Use local data if specified
    if args.local_data:
        config.use_huggingface = False
        config.data_path = args.local_data

    # Create runner with model/provider options
    runner = BFCLRunner(
        config,
        use_mock_agent=args.mock,
        provider=getattr(args, 'provider', None),
        model=getattr(args, 'model', None),
    )

    try:
        # Show which model is being used
        if not args.mock:
            from benchmarks.bfcl.models import get_default_model_config, get_model_config
            
            model_config = None
            if args.model:
                model_config = get_model_config(args.model)
            if model_config is None:
                model_config = get_default_model_config()
            
            if model_config:
                print(f"\n🤖 Model: {model_config.display_name}")
                print(f"   Provider: {model_config.provider.value}")
            else:
                print("\n⚠️  No model available, running in mock mode")
        
        if args.sample:
            # Run sample
            print(f"\n🚀 Running BFCL sample ({args.sample} tests)...\n")
            results = await runner.run_sample(
                n=args.sample,
                categories=config.categories,
            )
        else:
            # Run full benchmark
            print("\n🚀 Running full BFCL benchmark...\n")
            results = await runner.run()

        # Print results
        print_results(results)

        # Return exit code based on results
        if results.metrics.overall_score >= 0.5:
            return 0
        else:
            return 1

    except KeyboardInterrupt:
        print("\n\n⚠️ Benchmark interrupted by user")
        return 130
    except Exception as e:
        print(f"\n❌ Benchmark failed: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


def show_models(args: argparse.Namespace) -> int:
    """List available models."""
    from benchmarks.bfcl.models import (
        PROVIDER_CONFIGS,
        SUPPORTED_MODELS,
        get_available_providers,
        get_model_display_info,
    )
    
    if getattr(args, 'all', False):
        # Show all supported models
        print("\n📋 All Supported Models\n")
        
        current_provider = None
        for model_name, config in sorted(SUPPORTED_MODELS.items()):
            if config.provider != current_provider:
                current_provider = config.provider
                provider_config = PROVIDER_CONFIGS[current_provider]
                is_available = current_provider in get_available_providers()
                status = "✓" if is_available else "✗"
                env_hint = f"({provider_config.api_key_env})" if not provider_config.is_local else "(local)"
                print(f"\n{status} {current_provider.value.upper()} {env_hint}")
            
            default_marker = " [DEFAULT]" if config.is_default else ""
            cost = f"${config.cost_per_1k_tokens:.5f}/1K tokens" if config.cost_per_1k_tokens else "free"
            print(f"    {model_name}: {config.display_name}")
            print(f"        Max tokens: {config.max_tokens}, Cost: {cost}{default_marker}")
    else:
        # Show available models
        print("\n" + get_model_display_info())
        
        available = get_available_providers()
        if not available:
            print("\n⚠️  No providers available. Set one of these API keys:")
            print("   - GROQ_API_KEY (recommended)")
            print("   - OPENAI_API_KEY")
            print("   - ANTHROPIC_API_KEY")
            print("   - GOOGLE_GENERATIVE_AI_API_KEY")
            print("   - XAI_API_KEY")
            print("   - OPENROUTER_API_KEY")
        else:
            print("\nDefault: Groq llama-3.1-8b-instant")
            print("Override: --provider <name> or --model <provider/model>")
        
        print("\nUse --all to see all supported models")
    
    print()
    return 0


def show_info(args: argparse.Namespace) -> int:
    """Show benchmark information."""
    from benchmarks.bfcl.types import LEADERBOARD_SCORES

    if args.baselines:
        print("\n📊 BFCL Leaderboard Baselines\n")
        print(f"{'Model':<20} {'Overall':<10} {'AST':<10} {'Exec':<10}")
        print("-" * 50)
        for name, score in sorted(
            LEADERBOARD_SCORES.items(),
            key=lambda x: x[1].overall,
            reverse=True,
        ):
            print(
                f"{score.model_name:<20} "
                f"{score.overall:.2%}     "
                f"{score.ast:.2%}     "
                f"{score.exec:.2%}"
            )
        print()

    if args.categories:
        print("\n📁 Available Categories\n")
        for category in BFCLCategory:
            print(f"  - {category.value}")
        print()

    if not args.baselines and not args.categories:
        print("\n📋 BFCL Benchmark Information\n")
        print("The Berkeley Function-Calling Leaderboard (BFCL) evaluates")
        print("LLMs' function-calling capabilities across multiple dimensions.\n")
        print("Categories:")
        for category in BFCLCategory:
            print(f"  - {category.value}")
        print("\nUse --baselines to see leaderboard scores")
        print("Use --categories to see all categories\n")

    return 0


def main() -> int:
    """Main entry point."""
    args = parse_args()

    if args.command is None:
        print("Usage: python -m benchmarks.bfcl <command> [options]")
        print("Commands: run, models, info")
        print("\nDefault model: Groq llama-3.1-8b-instant")
        print("Use --help for more information")
        return 1

    # Set up logging
    verbose = getattr(args, "verbose", False)
    setup_logging(verbose)

    if args.command == "run":
        return asyncio.run(run_benchmark(args))
    elif args.command == "models":
        return show_models(args)
    elif args.command == "info":
        return show_info(args)
    else:
        print(f"Unknown command: {args.command}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
