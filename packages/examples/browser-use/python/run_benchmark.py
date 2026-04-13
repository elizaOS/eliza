#!/usr/bin/env python3
"""
Browser Use Example - Mind2Web Benchmark Runner

Demonstrates running a browser-use agent with ElizaOS on the Mind2Web benchmark.

Examples:
    # Quick test with sample tasks (no API key needed)
    python run_benchmark.py --sample

    # Run with Groq (fast and cheap)
    GROQ_API_KEY=your_key python run_benchmark.py --sample --real-llm --provider groq

    # Run with OpenAI
    OPENAI_API_KEY=your_key python run_benchmark.py --sample --real-llm --provider openai

    # Run more tasks
    python run_benchmark.py --sample --real-llm --provider groq --max-tasks 10
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

# Add repo root to path for imports
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def load_env() -> None:
    """Load environment variables from .env files."""
    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except ImportError:
        return

    # Try local .env
    local_env = Path(__file__).parent / ".env"
    if local_env.exists():
        load_dotenv(local_env, override=False)

    # Try repo root .env
    root_env = REPO_ROOT / ".env"
    if root_env.exists():
        load_dotenv(root_env, override=False)


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Browser Use Example - Mind2Web Benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Data source
    parser.add_argument(
        "--sample",
        action="store_true",
        help="Use sample tasks (default, no HuggingFace needed)",
    )
    parser.add_argument(
        "--hf",
        action="store_true",
        help="Load from HuggingFace Mind2Web dataset",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=3,
        help="Maximum tasks to run (default: 3)",
    )

    # Model
    parser.add_argument(
        "--real-llm",
        action="store_true",
        help="Use real LLM (requires API key)",
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=["groq", "openai", "anthropic", "auto"],
        default="auto",
        help="Model provider (default: auto-detect from env)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="LLM temperature (default: 0.0)",
    )

    # Output
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Verbose logging",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON",
    )

    return parser.parse_args()


async def run_benchmark(args: argparse.Namespace) -> dict[str, object]:
    """Run the Mind2Web benchmark."""
    from benchmarks.mind2web.runner import Mind2WebRunner
    from benchmarks.mind2web.types import Mind2WebConfig, Mind2WebSplit

    # Configure output directory
    if args.output:
        output_dir = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = str(Path(__file__).parent / "results" / "mind2web" / ts)

    # Create config
    config = Mind2WebConfig(
        output_dir=output_dir,
        split=Mind2WebSplit.TEST_TASK,
        max_tasks=args.max_tasks,
        num_trials=1,
        use_mock=not args.real_llm,
        model_provider=args.provider if args.provider != "auto" else None,
        temperature=args.temperature,
        verbose=args.verbose,
    )

    # Determine data source
    use_sample = args.sample or not args.hf
    use_huggingface = args.hf

    logger.info("=" * 60)
    logger.info("Browser Use Example - Mind2Web Benchmark")
    logger.info("=" * 60)
    logger.info(f"Mode: {'Real LLM' if args.real_llm else 'Mock'}")
    logger.info(f"Provider: {args.provider}")
    logger.info(f"Data source: {'HuggingFace' if use_huggingface else 'Sample tasks'}")
    logger.info(f"Max tasks: {args.max_tasks}")
    logger.info("=" * 60)

    # Run benchmark
    runner = Mind2WebRunner(
        config,
        use_sample=use_sample,
        use_huggingface=use_huggingface,
    )

    report = await runner.run_benchmark()

    # Return summary
    return {
        "total_tasks": report.total_tasks,
        "total_trials": report.total_trials,
        "task_success_rate": report.overall_task_success_rate,
        "step_accuracy": report.overall_step_accuracy,
        "element_accuracy": report.overall_element_accuracy,
        "operation_accuracy": report.overall_operation_accuracy,
        "average_latency_ms": report.average_latency_ms,
        "output_dir": output_dir,
    }


def print_results(results: dict[str, object], as_json: bool = False) -> None:
    """Print benchmark results."""
    if as_json:
        print(json.dumps(results, indent=2, default=str))
        return

    print()
    print("=" * 60)
    print("Mind2Web Benchmark Results")
    print("=" * 60)
    print(f"Tasks: {results['total_tasks']}, Trials: {results['total_trials']}")
    print(f"Task Success Rate: {float(results.get('task_success_rate', 0)) * 100:.1f}%")
    print(f"Step Accuracy: {float(results.get('step_accuracy', 0)) * 100:.1f}%")
    print(f"Element Accuracy: {float(results.get('element_accuracy', 0)) * 100:.1f}%")
    print(f"Avg Latency: {float(results.get('average_latency_ms', 0)):.0f}ms")
    print(f"\nResults saved to: {results.get('output_dir')}")
    print("=" * 60)


def main() -> int:
    """Main entry point."""
    load_env()
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Check for API keys if using real LLM
    if args.real_llm:
        has_key = (
            os.environ.get("GROQ_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
        )
        if not has_key:
            logger.error(
                "No API key found. Please set GROQ_API_KEY, OPENAI_API_KEY, "
                "or ANTHROPIC_API_KEY environment variable."
            )
            logger.info("Tip: GROQ_API_KEY is recommended for testing (fast and cheap)")
            logger.info("     Get a free key at: https://console.groq.com")
            return 1

    try:
        results = asyncio.run(run_benchmark(args))
        print_results(results, as_json=args.json)
        return 0

    except KeyboardInterrupt:
        logger.info("Interrupted")
        return 130

    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
