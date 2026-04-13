#!/usr/bin/env python3
"""
Mind2Web Benchmark CLI for ElizaOS.

Examples:
  # Run with sample tasks (uses real LLM by default)
  python -m benchmarks.mind2web --sample

  # Run with Groq (fast and cheap)
  GROQ_API_KEY=your_key python -m benchmarks.mind2web --sample --provider groq

  # Run with OpenAI
  OPENAI_API_KEY=your_key python -m benchmarks.mind2web --sample --provider openai

  # Run in mock mode (no API key needed, for testing only)
  python -m benchmarks.mind2web --sample --mock

  # Run full benchmark from HuggingFace
  python -m benchmarks.mind2web --hf --max-tasks 10

  # Run specific split
  python -m benchmarks.mind2web --hf --split test_website
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from benchmarks.mind2web.runner import Mind2WebRunner
from benchmarks.mind2web.types import Mind2WebConfig, Mind2WebSplit

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def _maybe_load_dotenv() -> None:
    """Best-effort loading of environment variables from .env."""
    try:
        from dotenv import find_dotenv, load_dotenv  # type: ignore[import-not-found]
    except ImportError:
        return

    try:
        # Try benchmark-specific env file
        local_env = Path(__file__).resolve().parent / ".env.mind2web"
        if local_env.exists():
            load_dotenv(local_env, override=False)

        # Try workspace .env
        env_path = find_dotenv(usecwd=True)
        if env_path:
            load_dotenv(env_path, override=False)
    except Exception:
        pass


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Mind2Web Benchmark CLI for ElizaOS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Data source
    parser.add_argument(
        "--sample",
        action="store_true",
        help="Use built-in sample tasks (default, no HuggingFace needed)",
    )
    parser.add_argument(
        "--hf",
        action="store_true",
        help="Load tasks from HuggingFace (requires datasets package)",
    )
    parser.add_argument(
        "--split",
        type=str,
        default="test_task",
        choices=["train", "test_task", "test_website", "test_domain"],
        help="Dataset split to use (default: test_task)",
    )

    # Task selection
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Maximum number of tasks to run",
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=1,
        help="Number of trials per task (default: 1)",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=20,
        help="Maximum steps per task (default: 20)",
    )

    # Output
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for results",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print results as JSON to stdout",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--no-details",
        action="store_true",
        help="Disable detailed result logging",
    )

    # Model configuration
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use mock agent instead of real LLM (for testing)",
    )
    parser.add_argument(
        "--real-llm",
        action="store_true",
        help="(deprecated, now the default) Use real LLM via ElizaOS runtime",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["groq", "openai", "anthropic", "auto", "milady"],
        default="auto",
        help="Model provider to use (default: auto-detect from env; 'milady' uses TS agent)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="LLM temperature (default: 0.0)",
    )
    parser.add_argument(
        "--groq-small-model",
        type=str,
        default="qwen3",
        help="Groq small model name (default: qwen3)",
    )
    parser.add_argument(
        "--groq-large-model",
        type=str,
        default="qwen3",
        help="Groq large model name (default: qwen3)",
    )

    # Runtime behavior
    parser.add_argument(
        "--check-should-respond",
        action="store_true",
        default=False,
        help="Enable checkShouldRespond (default: false)",
    )
    parser.add_argument(
        "--advanced-planning",
        action="store_true",
        default=False,
        help="Enable advanced planning plugin (default: false)",
    )

    # Timing
    parser.add_argument(
        "--timeout",
        type=int,
        default=120000,
        help="Timeout per task in milliseconds (default: 120000)",
    )

    return parser.parse_args()


def create_config(args: argparse.Namespace) -> Mind2WebConfig:
    """Create Mind2WebConfig from parsed arguments."""
    if args.output:
        output_dir = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/mind2web/{ts}"

    # Map split string to enum
    split_map = {
        "train": Mind2WebSplit.TRAIN,
        "test_task": Mind2WebSplit.TEST_TASK,
        "test_website": Mind2WebSplit.TEST_WEBSITE,
        "test_domain": Mind2WebSplit.TEST_DOMAIN,
    }
    split = split_map.get(args.split, Mind2WebSplit.TEST_TASK)

    return Mind2WebConfig(
        output_dir=output_dir,
        split=split,
        max_tasks=args.max_tasks,
        num_trials=max(1, args.trials),
        max_steps_per_task=max(1, args.max_steps),
        timeout_ms=max(1000, args.timeout),
        use_mock=bool(args.mock),
        model_provider=args.provider if args.provider != "auto" else None,
        temperature=args.temperature,
        groq_small_model=args.groq_small_model,
        groq_large_model=args.groq_large_model,
        verbose=args.verbose,
        save_detailed_logs=not args.no_details,
        check_should_respond=args.check_should_respond,
        advanced_planning=args.advanced_planning,
    )


async def run(
    config: Mind2WebConfig,
    *,
    use_sample: bool,
    use_huggingface: bool,
) -> dict[str, object]:
    """Run the benchmark."""
    runner = Mind2WebRunner(
        config,
        use_sample=use_sample,
        use_huggingface=use_huggingface,
    )

    report = await runner.run_benchmark()

    return {
        "total_tasks": report.total_tasks,
        "total_trials": report.total_trials,
        "task_success_rate": report.overall_task_success_rate,
        "step_accuracy": report.overall_step_accuracy,
        "element_accuracy": report.overall_element_accuracy,
        "operation_accuracy": report.overall_operation_accuracy,
        "average_latency_ms": report.average_latency_ms,
        "summary": report.summary,
        "output_dir": config.output_dir,
    }


def main() -> int:
    """Main entry point."""
    _maybe_load_dotenv()

    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Default to sample if neither sample nor hf specified
    use_sample = args.sample
    use_huggingface = args.hf

    if not use_sample and not use_huggingface:
        use_sample = True
        logger.info("Using sample tasks (use --hf to load from HuggingFace)")

    config = create_config(args)

    if config.use_mock:
        logger.warning(
            "WARNING: Running in mock mode. Results are not representative of real agent performance."
        )
    else:
        has_key = bool(
            os.environ.get("GROQ_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
        )
        if not has_key:
            logger.error(
                "ERROR: No API key found. Set OPENAI_API_KEY or use --mock for testing without LLMs."
            )
            return 1

    try:
        results = asyncio.run(
            run(config, use_sample=use_sample, use_huggingface=use_huggingface)
        )

        if args.json:
            print(json.dumps(results, indent=2, default=str))
        else:
            print("\n" + "=" * 60)
            print("Mind2Web Benchmark Results")
            print("=" * 60)
            print(f"Tasks: {results['total_tasks']}, Trials: {results['total_trials']}")
            print(f"Task Success Rate: {float(results.get('task_success_rate', 0)) * 100:.1f}%")
            print(f"Step Accuracy: {float(results.get('step_accuracy', 0)) * 100:.1f}%")
            print(f"Element Accuracy: {float(results.get('element_accuracy', 0)) * 100:.1f}%")
            print(f"Avg Latency: {float(results.get('average_latency_ms', 0)):.0f}ms")
            print(f"\nResults saved to: {config.output_dir}")
            print("=" * 60)

        return 0

    except KeyboardInterrupt:
        logger.info("Benchmark interrupted")
        return 130

    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        if args.json:
            print(json.dumps({"error": str(e)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
