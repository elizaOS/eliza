#!/usr/bin/env python3
"""ADHDBench CLI -- run attention & context scaling benchmarks.

Usage:
    python -m scripts.run_benchmark run --model gpt-4o --levels 0 1 2
    python -m scripts.run_benchmark run --quick
    python -m scripts.run_benchmark run --full
    python -m scripts.run_benchmark baselines
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

# Ensure the parent directory is importable
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from elizaos_adhdbench.baselines import (
    BOOTSTRAP_ACTION_NAMES,
    compute_always_reply_baseline,
    compute_random_baseline,
)
from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.scenarios import ALL_SCENARIOS, get_scenarios
from elizaos_adhdbench.types import ScalePoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="adhdbench",
        description="ADHDBench -- Attention & Context Scaling Benchmark for ElizaOS",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # -- run --
    run_parser = sub.add_parser("run", help="Run the benchmark")
    run_parser.add_argument("--model", default="gpt-4o-mini", help="Model name (default: gpt-4o-mini)")
    run_parser.add_argument("--provider", default="openai", help="Model provider (default: openai)")
    run_parser.add_argument("--levels", nargs="+", type=int, default=[0, 1, 2], help="Levels to run (0, 1, 2)")
    run_parser.add_argument("--tags", nargs="+", default=[], help="Filter by scenario tags")
    run_parser.add_argument("--ids", nargs="+", default=[], help="Filter by scenario IDs")
    run_parser.add_argument("--output", default="./adhdbench_results", help="Output directory")
    run_parser.add_argument("--quick", action="store_true", help="Quick mode: L0 only, 2 scale points, basic only")
    run_parser.add_argument("--full", action="store_true", help="Full mode: all levels, all scales, both configs")
    run_parser.add_argument("--basic-only", action="store_true", help="Only run basic config")
    run_parser.add_argument("--full-only", action="store_true", help="Only run full config")
    run_parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")

    # -- baselines --
    base_parser = sub.add_parser("baselines", help="Compute baseline scores")
    base_parser.add_argument("--levels", nargs="+", type=int, default=[0, 1, 2])

    # -- list --
    list_parser = sub.add_parser("list", help="List all scenarios")
    list_parser.add_argument("--levels", nargs="+", type=int, default=[0, 1, 2])
    list_parser.add_argument("--tags", nargs="+", default=[])

    return parser.parse_args()


def cmd_run(args: argparse.Namespace) -> None:
    """Run the benchmark."""
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    # Build config from args
    if args.quick:
        config = ADHDBenchConfig(
            scale_points=(
                ScalePoint(action_count=10, provider_count=8, conversation_prefill=0),
                ScalePoint(action_count=50, provider_count=18, conversation_prefill=30),
            ),
            run_basic=True,
            run_full=False,
            levels=(0,),
            model_name=args.model,
            model_provider=args.provider,
            output_dir=args.output,
        )
    elif args.full:
        config = ADHDBenchConfig(
            model_name=args.model,
            model_provider=args.provider,
            output_dir=args.output,
            levels=tuple(args.levels),
            tags=tuple(args.tags),
            scenario_ids=tuple(args.ids),
        )
    else:
        config = ADHDBenchConfig(
            model_name=args.model,
            model_provider=args.provider,
            output_dir=args.output,
            levels=tuple(args.levels),
            tags=tuple(args.tags),
            scenario_ids=tuple(args.ids),
            run_basic=not args.full_only,
            run_full=not args.basic_only,
        )

    def progress(config_name: str, scale: str, current: int, total: int) -> None:
        print(f"  [{config_name}/{scale}] {current}/{total}", end="\r", flush=True)

    from elizaos_adhdbench.runner import ADHDBenchRunner
    runner = ADHDBenchRunner(config)
    results = asyncio.run(runner.run(progress_callback=progress))

    print(f"\nBenchmark complete. {len(results.results)} scenario results.")
    print(f"Results saved to: {config.output_dir}/")


def cmd_baselines(args: argparse.Namespace) -> None:
    """Compute and display baseline scores."""
    levels = tuple(args.levels)
    scenarios = get_scenarios(levels=levels)

    from elizaos_adhdbench.distractor_plugin import get_distractor_plugin_actions_for_scale
    action_pool = BOOTSTRAP_ACTION_NAMES + [
        a.name for a in get_distractor_plugin_actions_for_scale(50, len(BOOTSTRAP_ACTION_NAMES))
    ]

    print(f"Computing baselines for {len(scenarios)} scenarios (levels {levels})...")
    print()

    random_score = compute_random_baseline(scenarios, action_pool)
    reply_score = compute_always_reply_baseline(scenarios)

    print(f"  Random baseline:      {random_score:.1%}")
    print(f"  Always-REPLY baseline: {reply_score:.1%}")
    print()
    print("Any real agent should score significantly above both baselines.")


def cmd_list(args: argparse.Namespace) -> None:
    """List all scenarios matching filters."""
    levels = tuple(args.levels)
    tags = tuple(args.tags)
    scenarios = get_scenarios(levels=levels, tags=tags)

    print(f"{'ID':<10} {'Level':<10} {'Name':<40} {'Tags'}")
    print("-" * 100)
    for s in scenarios:
        tags_str = ", ".join(s.tags)
        level_str = f"L{s.level.value}"
        features = []
        if s.requires_advanced_memory:
            features.append("mem")
        if s.requires_advanced_planning:
            features.append("plan")
        feat_str = f" [{','.join(features)}]" if features else ""
        print(f"{s.id:<10} {level_str:<10} {s.name:<40} {tags_str}{feat_str}")
    print(f"\nTotal: {len(scenarios)} scenarios")


def main() -> None:
    args = parse_args()
    if args.command == "run":
        cmd_run(args)
    elif args.command == "baselines":
        cmd_baselines(args)
    elif args.command == "list":
        cmd_list(args)


if __name__ == "__main__":
    main()
