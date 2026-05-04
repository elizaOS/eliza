#!/usr/bin/env python3
"""
Run the Context Benchmark via the eliza TS bridge.

The query path always goes through the eliza TypeScript benchmark server
via ``eliza_adapter.context_bench.make_eliza_llm_query``. The legacy
direct-OpenAI / direct-Anthropic / Python-AgentRuntime / heuristic-mock
modes have been removed.
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from elizaos_context_bench import (
    ContextBenchConfig,
    ContextBenchRunner,
    ContextBenchReporter,
    NeedlePosition,
    save_results,
)


def _load_env_file(env_path: Path) -> None:
    """
    Minimal .env loader (no external dependency).

    - Only sets keys that are not already present in os.environ.
    - Ignores blank lines and comments.
    """
    if not env_path.exists():
        return

    try:
        content = env_path.read_text(encoding="utf-8")
    except Exception:
        return

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        if key not in os.environ:
            os.environ[key] = value


def get_llm_query_fn():
    """Return the eliza-bridge LLM query function."""
    from eliza_adapter.context_bench import make_eliza_llm_query

    return make_eliza_llm_query()


async def run_benchmark(
    quick: bool = False,
    output_dir: str = "./benchmark_results",
) -> object:
    """Run the context benchmark via the eliza TS bridge."""

    repo_root = Path(__file__).resolve().parents[2]
    _load_env_file(repo_root / ".env")

    print("=" * 60)
    print("ElizaOS Context Benchmark")
    print("=" * 60)
    print("Provider: eliza-ts-bridge")
    print(f"Mode: {'Quick' if quick else 'Full'}")
    print(f"Output: {output_dir}")
    print()

    if quick:
        config = ContextBenchConfig(
            context_lengths=[1024, 4096],
            positions=[NeedlePosition.START, NeedlePosition.MIDDLE, NeedlePosition.END],
            tasks_per_position=2,
            run_niah_basic=True,
            run_niah_semantic=False,
            run_multi_hop=False,
            output_dir=output_dir,
        )
    else:
        config = ContextBenchConfig(
            context_lengths=[1024, 2048, 4096, 8192, 16384],
            positions=[
                NeedlePosition.START,
                NeedlePosition.EARLY,
                NeedlePosition.MIDDLE,
                NeedlePosition.LATE,
                NeedlePosition.END,
            ],
            tasks_per_position=3,
            run_niah_basic=True,
            run_niah_semantic=True,
            run_multi_hop=True,
            multi_hop_depths=[2, 3],
            output_dir=output_dir,
        )

    def on_progress(suite: str, completed: int, total: int) -> None:
        pct = completed / total * 100 if total > 0 else 0
        bar_len = 30
        filled = int(bar_len * completed / total) if total > 0 else 0
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r{suite}: [{bar}] {completed}/{total} ({pct:.1f}%)", end="", flush=True)

    llm_fn = get_llm_query_fn()

    runner = ContextBenchRunner(
        config=config,
        llm_query_fn=llm_fn,
        seed=42,
    )

    print("Running benchmark...")
    print()
    results = await runner.run_full_benchmark(progress_callback=on_progress)

    print("\n")

    reporter = ContextBenchReporter(results)
    reporter.print_report()

    os.makedirs(output_dir, exist_ok=True)
    paths = save_results(results, output_dir, prefix="context_bench_eliza")

    print("\nResults saved to:")
    for file_type, path in paths.items():
        print(f"  {file_type}: {path}")

    return results


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="benchmarks.context-bench.run_benchmark",
        description="Run the Context Benchmark via the eliza TS bridge.",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Run a smaller config (NIAH-basic only, 2 lengths × 3 positions × 2 tasks)",
    )
    parser.add_argument(
        "--output-dir",
        default="./benchmark_results",
        help="Output directory for results",
    )
    args = parser.parse_args()

    asyncio.run(
        run_benchmark(
            quick=args.quick,
            output_dir=args.output_dir,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
