#!/usr/bin/env python3
"""Run the agent trust & security benchmark.

Usage:
    python run_benchmark.py
    python run_benchmark.py --handler oracle
    python run_benchmark.py --handler oracle --output results.json
    python run_benchmark.py --handler eliza              # LLM-based detection via Eliza runtime
    python run_benchmark.py --categories prompt_injection social_engineering
    python run_benchmark.py --difficulty easy medium
    python run_benchmark.py --threshold 0.8
"""

import argparse
import sys
from pathlib import Path

# Add benchmark path
sys.path.insert(0, str(Path(__file__).parent))

from elizaos_trust_bench.baselines import PerfectHandler, RandomHandler
from elizaos_trust_bench.runner import TrustBenchmarkRunner
from elizaos_trust_bench.types import BenchmarkConfig, Difficulty, ThreatCategory


def _discover_handler_names() -> list[str]:
    """Discover which handlers are available without instantiating them.

    Returns the list of handler names whose dependencies can be imported.
    Cheap handlers (oracle, random) are always available.
    """
    names: list[str] = ["oracle", "random"]

    try:
        from elizaos_trust_bench.real_handler import RealTrustHandler  # noqa: F401

        names.append("real")
    except ImportError:
        pass

    try:
        from elizaos_trust_bench.eliza_handler import ELIZAOS_AVAILABLE

        if ELIZAOS_AVAILABLE:
            names.append("eliza")
    except ImportError:
        pass

    return names


def _create_handler(
    name: str,
    *,
    model_provider: str | None = None,
    model_name: str | None = None,
) -> object:
    """Instantiate a handler by name.

    Handlers:
    - oracle: Ground truth (perfect score, validates benchmark framework)
    - random: Coin flip baseline (validates benchmark discriminates)
    - real: Pattern-based detection via trust plugin's SecurityModule
    - eliza: LLM-based detection via a full ElizaOS AgentRuntime (requires
             OPENAI_API_KEY and elizaos + elizaos-plugin-openai packages)
    """
    if name == "oracle":
        return PerfectHandler()
    if name == "random":
        return RandomHandler()
    if name == "real":
        from elizaos_trust_bench.real_handler import RealTrustHandler

        return RealTrustHandler()
    if name == "eliza":
        from elizaos_trust_bench.eliza_handler import ElizaTrustHandler

        return ElizaTrustHandler(
            model_provider=model_provider,
            model_name=model_name,
        )

    raise ValueError(f"Unknown handler: {name}")


# Discover available handler names (cheap — no instantiation)
AVAILABLE_HANDLERS: list[str] = _discover_handler_names()


def main() -> None:
    """Run the benchmark."""
    parser = argparse.ArgumentParser(
        description="Agent Trust & Security Benchmark",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_benchmark.py                                    # Run with oracle handler
  python run_benchmark.py --handler random                   # Run with random handler
  python run_benchmark.py --handler real                     # Pattern-based detection
  python run_benchmark.py --handler eliza                    # LLM-based detection (Eliza)
  python run_benchmark.py --categories prompt_injection      # Only test prompt injection
  python run_benchmark.py --difficulty hard                   # Only hard cases
  python run_benchmark.py --threshold 0.8 --output out.json  # Set pass threshold + output

Handler descriptions:
  oracle  Ground truth oracle — validates benchmark framework (should score 100%%)
  random  Coin flip baseline — validates benchmark discriminates good from bad
  real    Pattern-based detection using the trust plugin's SecurityModule
  eliza   LLM-based detection using a full ElizaOS agent with OpenAI
        """,
    )
    parser.add_argument(
        "--handler",
        type=str,
        default="oracle",
        choices=AVAILABLE_HANDLERS,
        help="Handler to benchmark (default: oracle)",
    )
    parser.add_argument(
        "--categories",
        nargs="+",
        type=str,
        default=None,
        help="Categories to test (default: all)",
    )
    parser.add_argument(
        "--difficulty",
        nargs="+",
        type=str,
        default=None,
        help="Difficulty levels to include (default: all)",
    )
    parser.add_argument(
        "--tags",
        nargs="+",
        type=str,
        default=None,
        help="Only run cases with these tags",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="Minimum overall F1 to pass (default: 0.5)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output JSON path for results",
    )
    parser.add_argument(
        "--model-provider",
        type=str,
        choices=["openai", "groq", "openrouter", "anthropic", "google", "ollama"],
        default=None,
        help="Model provider to use for --handler eliza (default: auto-detect)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model name for --handler eliza (e.g. qwen3-32b)",
    )
    args = parser.parse_args()

    # Parse categories
    categories = None
    if args.categories:
        categories = [ThreatCategory(c) for c in args.categories]

    # Parse difficulties
    difficulties = None
    if args.difficulty:
        difficulties = [Difficulty(d) for d in args.difficulty]

    config = BenchmarkConfig(
        categories=categories,
        difficulties=difficulties,
        tags=args.tags,
        fail_threshold=args.threshold,
        output_path=args.output,
    )

    # Create the handler on demand (eliza handler is expensive to instantiate)
    print(f"[TrustBench] Creating handler: {args.handler}")
    handler = _create_handler(
        args.handler,
        model_provider=args.model_provider,
        model_name=args.model,
    )

    runner = TrustBenchmarkRunner(config)
    result = runner.run_and_report(handler, output_path=args.output)

    # Clean up eliza handler resources if it was used
    if hasattr(handler, "close") and callable(getattr(handler, "close")):
        handler.close()  # type: ignore[union-attr]

    # Exit code based on overall quality
    if result.overall_f1 < args.threshold:
        sys.exit(1)


if __name__ == "__main__":
    main()
