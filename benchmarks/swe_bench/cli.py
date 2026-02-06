#!/usr/bin/env python3
"""CLI for running SWE-bench benchmark."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

# Add workspace root and local elizaos python package to sys.path (dev-friendly).
_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT))
_PYTHON_PKG = _ROOT / "packages" / "python"
if _PYTHON_PKG.exists():
    sys.path.insert(0, str(_PYTHON_PKG))

from .character import create_swe_bench_character
from .dataset import SWEBenchDataset
from .runner import SWEBenchRunner
from .types import SWEBenchConfig, SWEBenchVariant


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run SWE-bench benchmark on ElizaOS Python",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run on SWE-bench Lite (default, 300 instances)
  python -m benchmarks.swe_bench.cli

  # Run on first 10 instances
  python -m benchmarks.swe_bench.cli --max-instances 10

  # Run on specific repository
  python -m benchmarks.swe_bench.cli --repo-filter django

  # Run single instance
  python -m benchmarks.swe_bench.cli --instance django__django-12345

  # Run on SWE-bench Verified
  python -m benchmarks.swe_bench.cli --variant verified

  # List available instances
  python -m benchmarks.swe_bench.cli --list

  # Skip Docker evaluation
  python -m benchmarks.swe_bench.cli --no-docker
""",
    )

    parser.add_argument(
        "--variant",
        choices=["lite", "verified", "full"],
        default="lite",
        help="SWE-bench variant to use (default: lite)",
    )

    parser.add_argument(
        "--max-instances",
        type=int,
        default=None,
        help="Maximum number of instances to evaluate",
    )

    parser.add_argument(
        "--repo-filter",
        type=str,
        default=None,
        help="Filter instances by repository name",
    )

    parser.add_argument(
        "--instance",
        type=str,
        default=None,
        help="Run on a single instance by ID",
    )

    parser.add_argument(
        "--max-steps",
        type=int,
        default=30,
        help="Maximum agent steps per instance (default: 30)",
    )

    parser.add_argument(
        "--workspace",
        type=str,
        default="./swe-bench-workspace",
        help="Workspace directory for cloned repos",
    )

    parser.add_argument(
        "--output",
        type=str,
        default="./benchmark_results/swe-bench",
        help="Output directory for results",
    )

    parser.add_argument(
        "--no-docker",
        action="store_true",
        help="Skip Docker-based test evaluation",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Timeout per instance in seconds (default: 600)",
    )

    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4",
        help="Model to use for the agent",
    )

    parser.add_argument(
        "--gold",
        action="store_true",
        help="Evaluate using the gold (ground-truth) patches instead of running the agent (useful to validate the harness).",
    )

    parser.add_argument(
        "--mock-model",
        action="store_true",
        help="Use a deterministic mock model (no API calls). Useful for smoke tests.",
    )

    parser.add_argument(
        "--swebench-namespace",
        type=str,
        default=None,
        help="Optional Docker registry namespace for SWE-bench instance images (e.g., 'ghcr.io/epoch-research')",
    )

    parser.add_argument(
        "--swebench-max-workers",
        type=int,
        default=1,
        help="Max parallel SWE-bench harness workers (default: 1)",
    )

    parser.add_argument(
        "--list",
        action="store_true",
        help="List available instances and exit",
    )

    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show dataset statistics and exit",
    )

    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


async def list_instances(args: argparse.Namespace) -> None:
    """List available instances."""
    variant = SWEBenchVariant(args.variant)
    dataset = SWEBenchDataset(variant)

    print(f"Loading SWE-bench {variant.value}...")
    await dataset.load()

    instances = dataset.get_instances(
        repo_filter=args.repo_filter,
        limit=args.max_instances,
    )

    print(f"\nFound {len(instances)} instances:\n")

    for instance in instances:
        print(f"  {instance.instance_id}")
        print(f"    Repo: {instance.repo}")
        print(f"    Created: {instance.created_at}")
        print(f"    Tests to pass: {len(instance.fail_to_pass)}")
        print()


async def show_stats(args: argparse.Namespace) -> None:
    """Show dataset statistics."""
    variant = SWEBenchVariant(args.variant)
    dataset = SWEBenchDataset(variant)

    print(f"Loading SWE-bench {variant.value}...")
    await dataset.load()

    stats = dataset.get_statistics()
    by_repo = dataset.get_by_repo()

    print(f"\n=== SWE-bench {variant.value.upper()} Statistics ===\n")
    print(f"Total instances: {stats.total_instances}")
    print(f"Number of repositories: {stats.num_repos}")
    print(f"Average per repository: {stats.avg_per_repo:.1f}")

    print("\nBy Repository:")
    for repo, instances in sorted(by_repo.items(), key=lambda x: -len(x[1])):
        print(f"  {repo}: {len(instances)} instances")


async def run_benchmark(args: argparse.Namespace) -> None:
    """Run the benchmark."""
    # Import here to avoid import errors if elizaos not installed
    try:
        from elizaos.runtime import AgentRuntime
    except ImportError:
        print("Error: elizaos package not found. Please install it first.")
        print("  pip install elizaos")
        sys.exit(1)

    # Create configuration
    variant = SWEBenchVariant(args.variant)
    config = SWEBenchConfig(
        variant=variant,
        workspace_dir=args.workspace,
        output_dir=args.output,
        max_steps=args.max_steps,
        max_instances=args.max_instances,
        repo_filter=args.repo_filter,
        use_docker_eval=not args.no_docker,
        timeout_seconds=args.timeout,
        model_name=args.model,
        use_gold_patches=bool(args.gold),
        swebench_namespace=args.swebench_namespace,
        swebench_max_workers=args.swebench_max_workers,
    )

    # Create SWE-bench character with proper templates and settings
    character = create_swe_bench_character(
        name="SWE-Agent",
        model_name=args.model,
    )

    # Create runtime with character - basicCapabilities enabled by default
    runtime = AgentRuntime(
        character=character,
        log_level="DEBUG" if args.verbose else "INFO",
        # Don't disable basic capabilities - we want providers, actions, etc.
        disable_basic_capabilities=False,
        # Disable the should-respond check - always respond in benchmark mode
        check_should_respond=False,
    )

    # Initialize runtime - this registers bootstrap plugin with basic capabilities
    await runtime.initialize()

    # Register a model handler (Python runtime does not ship with one by default).
    # When running in --gold mode we don't need any model handler.
    if args.gold:
        pass
    else:
        from elizaos.types.model import ModelType

        if args.mock_model:
            # Counter to track mock calls for varied responses
            _mock_call_count = [0]

            async def _mock_text_large(_runtime: object, params: dict[str, object]) -> str:
                """Mock model that returns XML-formatted responses for testing."""
                _ = _runtime
                _ = params
                _mock_call_count[0] += 1
                call_num = _mock_call_count[0]

                # Return a sequence of actions for testing the flow
                if call_num == 1:
                    return """<response>
<thought>Let me start by listing the files to understand the repository structure.</thought>
<text>Listing repository files...</text>
<actions>LIST_FILES</actions>
<params>
<LIST_FILES>
<directory>.</directory>
<pattern>*.py</pattern>
</LIST_FILES>
</params>
</response>"""
                elif call_num == 2:
                    return """<response>
<thought>Now that I've seen the structure, let me submit since this is a mock test.</thought>
<text>Submitting mock solution...</text>
<actions>SUBMIT</actions>
<params>
</params>
</response>"""
                else:
                    # Default: just submit
                    return """<response>
<thought>Mock mode - submitting.</thought>
<text>Done.</text>
<actions>SUBMIT</actions>
<params>
</params>
</response>"""

            runtime.register_model(
                ModelType.TEXT_LARGE, _mock_text_large, provider="mock", priority=100
            )
        else:
            # OpenAI is the default supported provider for this CLI.
            if not os.getenv("OPENAI_API_KEY"):
                print("Error: No model handler registered and OPENAI_API_KEY is not set.")
                print("Tip: set OPENAI_API_KEY or run with --mock-model for a smoke test.")
                sys.exit(1)

            from openai import AsyncOpenAI

            client = AsyncOpenAI()
            model_name = args.model

            async def _openai_text_large(_runtime: object, params: dict[str, object]) -> str:
                """OpenAI model handler for SWE-bench."""
                _ = _runtime
                prompt_raw = params.get("prompt", "")
                prompt = str(prompt_raw) if prompt_raw is not None else ""

                system_raw = params.get("system", "")
                system = str(system_raw) if system_raw else None

                temperature_raw = params.get("temperature", 0.1)
                temperature = (
                    float(temperature_raw) if isinstance(temperature_raw, int | float) else 0.1
                )

                max_tokens_raw = params.get("maxTokens")
                max_tokens: int | None = None
                if isinstance(max_tokens_raw, int):
                    max_tokens = max_tokens_raw
                elif isinstance(max_tokens_raw, float):
                    max_tokens = int(max_tokens_raw)

                messages: list[dict[str, str]] = []
                if system:
                    messages.append({"role": "system", "content": system})
                messages.append({"role": "user", "content": prompt})

                # gpt-5/o1/o3 reasoning models: max_completion_tokens, no temperature
                extra: dict[str, object] = {}
                if max_tokens is not None:
                    extra["max_completion_tokens"] = max_tokens
                is_reasoning = any(model_name.startswith(p) for p in ("gpt-5", "o1", "o3"))
                if not is_reasoning:
                    extra["temperature"] = temperature

                resp = await client.chat.completions.create(
                    model=model_name,
                    messages=messages,  # type: ignore[arg-type]
                    **extra,
                )
                content = resp.choices[0].message.content
                return content or ""

            runtime.register_model(
                ModelType.TEXT_LARGE, _openai_text_large, provider="openai", priority=100
            )

    # Create and run benchmark
    runner = SWEBenchRunner(runtime, config)

    if args.instance:
        # Run single instance
        print(f"Running on single instance: {args.instance}")
        result = await runner.run_single(args.instance)

        print("\n=== Result ===")
        print(f"Instance: {result.instance_id}")
        print(f"Success: {result.success}")
        print(f"Patch Status: {result.patch_status.value}")
        print(f"Duration: {result.duration_seconds:.1f}s")
        print(f"Tests Passed: {len(result.tests_passed)}")
        print(f"Tests Failed: {len(result.tests_failed)}")

        if result.error:
            print(f"Error: {result.error}")

        if result.generated_patch:
            print("\n=== Generated Patch ===")
            print(result.generated_patch[:2000])
            if len(result.generated_patch) > 2000:
                print(f"... ({len(result.generated_patch)} bytes total)")
    else:
        # Run full benchmark
        report = await runner.run_benchmark()

        print("\n" + "=" * 60)
        print("SWE-BENCH BENCHMARK RESULTS")
        print("=" * 60)
        print(f"Variant: {report.variant}")
        print(f"Total Instances: {report.total_instances}")
        print(f"Resolved: {report.resolved}")
        print(f"Resolve Rate: {report.resolve_rate:.1%}")
        print(f"Apply Rate: {report.apply_rate:.1%}")
        print(f"Average Duration: {report.average_duration:.1f}s")
        print("=" * 60)

    # Cleanup
    await runtime.stop()


async def async_main() -> None:
    """Async main entry point."""
    # Best-effort: load .env if present (no-op if missing).
    try:
        from dotenv import load_dotenv

        load_dotenv(dotenv_path=_ROOT / ".env", override=False)
    except Exception:
        pass

    args = parse_args()
    setup_logging(args.verbose)

    if args.list:
        await list_instances(args)
    elif args.stats:
        await show_stats(args)
    else:
        await run_benchmark(args)


def main() -> None:
    """Console-script entry point (sync wrapper)."""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
