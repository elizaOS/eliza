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
import re
import sys
from pathlib import Path

# Add parent directory to path for imports
BENCHMARK_DIR = Path(__file__).resolve().parent
BENCHMARKS_DIR = BENCHMARK_DIR.parent
sys.path.insert(0, str(BENCHMARK_DIR))
sys.path.insert(0, str(BENCHMARKS_DIR / "eliza-adapter"))

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


def _make_mock_llm_query():
    """Return a deterministic local query function for smoke tests."""

    semantic_answers = {
        "How much money did the main product bring in this year?": "$47 million",
        "What percentage of patients improved with the new treatment?": "73%",
        "When will the computing facility be finished?": "Q4 2025",
        "Who recently became the head of technology?": "Dr. Sarah Mitchell",
        "How fast can the rocket travel at its highest speed?": "28,000 kilometers per hour",
        "Where is Project Phoenix headquartered?": "Building 7",
        "What code is needed to access the encryption key?": "7749",
        "What is the budget for the division where Dr. Chen's team operates?": "$12 million",
        "Where is the data from server cluster X ultimately backed up?": "facility W",
    }
    patterns = [
        (r"The secret code for the vault is ([^.]+)\.", "What is the secret code for the vault?"),
        (r"The headquarters is located at ([^.]+)\.", "Where is the headquarters located?"),
        (r"The project's codename is ([^.]+)\.", "What is the project's codename?"),
        (r"The password to access the system is ([^.]+)\.", "What is the password to access the system?"),
        (r"The meeting point has been set to ([^.]+)\.", "What is the meeting point?"),
        (r"The total budget allocated was exactly \$(\d+)\.", "What was the total budget allocated?"),
        (r"The experiment recorded a temperature of ([^.]+) degrees Celsius\.", "What temperature did the experiment record?"),
        (r"The population count reached ([^.]+) individuals\.", "What was the population count?"),
        (r"The speed measured was ([^.]+) kilometers per hour\.", "What speed was measured?"),
        (r"The compound's molecular weight is ([^.]+)\.", "What is the compound's molecular weight?"),
        (r"The deadline for submission is ([^.]+)\.", "What is the deadline for submission?"),
        (r"The company was founded on ([^.]+)\.", "When was the company founded?"),
        (r"The event is scheduled for ([^.]+)\.", "When is the event scheduled?"),
        (r"The treaty was signed on ([^.]+)\.", "When was the treaty signed?"),
        (r"The discovery was made on ([^.]+)\.", "When was the discovery made?"),
        (r"The lead researcher is Dr\. ([^.]+)\.", "Who is the lead researcher?"),
        (r"The CEO's name is ([^.]+)\.", "What is the CEO's name?"),
        (r"The architect who designed it was ([^.]+)\.", "Who designed it?"),
        (r"The author of the report is ([^.]+)\.", "Who is the author of the report?"),
        (r"The inventor was ([^.]+)\.", "Who was the inventor?"),
        (r"The API endpoint is ([^.]+)\.", "What is the API endpoint?"),
        (r"The function to call is ([^.]+)\.", "What function should be called?"),
        (r"The configuration key is ([^.]+)\.", "What is the configuration key?"),
        (r"The error code returned was ([^.]+)\.", "What error code was returned?"),
        (r"The command to execute is ([^.]+)\.", "What command should be executed?"),
    ]

    async def mock_llm_query(context: str, question: str) -> str:
        if question in semantic_answers:
            return semantic_answers[question]
        for pattern, pattern_question in patterns:
            if question == pattern_question:
                match = re.search(pattern, context)
                if match:
                    return match.group(1)
        return ""

    return mock_llm_query


def get_llm_query_fn(provider: str, client: object | None = None):
    """Return the selected benchmark query function."""
    normalized = provider.strip().lower()
    if normalized == "mock":
        return _make_mock_llm_query()

    from eliza_adapter.context_bench import make_eliza_llm_query

    return make_eliza_llm_query(client=client)


async def run_benchmark(
    quick: bool = False,
    output_dir: str = "./benchmark_results",
    provider: str = "eliza",
    context_lengths: list[int] | None = None,
    positions: list[NeedlePosition] | None = None,
    tasks_per_position: int | None = None,
) -> object:
    """Run the context benchmark via the eliza TS bridge."""

    repo_root = Path(__file__).resolve().parents[2]
    _load_env_file(repo_root / ".env")

    print("=" * 60)
    print("ElizaOS Context Benchmark")
    print("=" * 60)
    print(f"Provider: {provider}")
    print(f"Mode: {'Quick' if quick else 'Full'}")
    print(f"Output: {output_dir}")
    print()

    if quick:
        config = ContextBenchConfig(
            context_lengths=context_lengths or [1024, 4096],
            positions=positions or [NeedlePosition.START, NeedlePosition.MIDDLE, NeedlePosition.END],
            tasks_per_position=tasks_per_position or 2,
            run_niah_basic=True,
            run_niah_semantic=False,
            run_multi_hop=False,
            output_dir=output_dir,
        )
    else:
        config = ContextBenchConfig(
            context_lengths=context_lengths or [1024, 2048, 4096, 8192, 16384],
            positions=positions or [
                NeedlePosition.START,
                NeedlePosition.EARLY,
                NeedlePosition.MIDDLE,
                NeedlePosition.LATE,
                NeedlePosition.END,
            ],
            tasks_per_position=tasks_per_position or 3,
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

    bridge_manager = None
    if provider.strip().lower() != "mock":
        from eliza_adapter.server_manager import ElizaServerManager

        bridge_manager = ElizaServerManager()
        bridge_manager.start()

    llm_fn = get_llm_query_fn(
        provider,
        client=bridge_manager.client if bridge_manager is not None else None,
    )

    try:
        runner = ContextBenchRunner(
            config=config,
            llm_query_fn=llm_fn,
            seed=42,
        )

        print("Running benchmark...")
        print()
        results = await runner.run_full_benchmark(progress_callback=on_progress)
    finally:
        if bridge_manager is not None:
            bridge_manager.stop()

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
    parser.add_argument(
        "--provider",
        default="eliza",
        help="Query provider: eliza/eliza-ts-bridge or mock",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Accepted for registry compatibility; model selection is handled by the provider bridge.",
    )
    parser.add_argument(
        "--context-lengths",
        default=None,
        help="Comma-separated context lengths for focused smoke tests",
    )
    parser.add_argument(
        "--positions",
        default=None,
        help="Comma-separated positions: start,early,middle,late,end,random",
    )
    parser.add_argument(
        "--tasks-per-position",
        type=int,
        default=None,
        help="Override number of tasks per position/length",
    )
    args = parser.parse_args()
    context_lengths = (
        [int(value) for value in args.context_lengths.split(",") if value.strip()]
        if args.context_lengths
        else None
    )
    positions = (
        [NeedlePosition(value.strip()) for value in args.positions.split(",") if value.strip()]
        if args.positions
        else None
    )

    asyncio.run(
        run_benchmark(
            quick=args.quick,
            output_dir=args.output_dir,
            provider=args.provider,
            context_lengths=context_lengths,
            positions=positions,
            tasks_per_position=args.tasks_per_position,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
