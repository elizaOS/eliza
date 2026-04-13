"""
CLI entry point for the HyperliquidBench Eliza agent.

Usage:
    python -m benchmarks.HyperliquidBench.eliza_agent [OPTIONS]

Examples:
    # Run with demo mode (default) – no real trades
    python -m benchmarks.HyperliquidBench.eliza_agent --demo

    # Run free-form coverage scenario with specific coins
    python -m benchmarks.HyperliquidBench.eliza_agent --coins ETH,BTC,SOL --max-steps 7

    # Run scenarios from task files
    python -m benchmarks.HyperliquidBench.eliza_agent --tasks hl_perp_basic_01.jsonl

    # Verbose output with custom model
    python -m benchmarks.HyperliquidBench.eliza_agent --model gpt-4o --verbose

    # Live network (requires HL_PRIVATE_KEY)
    python -m benchmarks.HyperliquidBench.eliza_agent --network testnet --no-demo
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="benchmarks.HyperliquidBench.eliza_agent",
        description="Run HyperliquidBench scenarios through an ElizaOS agent",
    )

    # Scenario selection
    parser.add_argument(
        "--tasks",
        nargs="*",
        default=None,
        help=(
            "Task JSONL filenames (relative to dataset/tasks/).  "
            "If omitted, loads all task files or uses a free-form coverage scenario."
        ),
    )
    parser.add_argument(
        "--coverage",
        action="store_true",
        default=False,
        help="Run a single free-form coverage scenario (agent decides the plan)",
    )
    parser.add_argument(
        "--coins",
        type=str,
        default="ETH,BTC",
        help="Comma-separated allowed coins (default: ETH,BTC)",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=5,
        help="Maximum steps the agent can include in a plan (default: 5)",
    )
    parser.add_argument(
        "--builder-code",
        type=str,
        default=None,
        help="Builder code to attach to orders",
    )

    # Execution settings
    parser.add_argument(
        "--demo",
        action="store_true",
        default=True,
        help="Run in demo mode – no real trading (default)",
    )
    parser.add_argument(
        "--no-demo",
        action="store_true",
        default=False,
        help="Disable demo mode – execute on real network",
    )
    parser.add_argument(
        "--network",
        type=str,
        default="testnet",
        choices=["testnet", "mainnet", "local"],
        help="Network to target (default: testnet)",
    )

    # Model settings
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4o",
        help="Model name for plan generation (default: gpt-4o)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature (default: 0.2)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=3,
        help="Max iterations per scenario (default: 3)",
    )

    # Output
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        default=False,
        help="Enable verbose/debug logging",
    )

    return parser.parse_args()


async def _main() -> int:
    args = _parse_args()

    # Configure logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Lazy imports so --help is fast
    from .eliza_agent import (
        ElizaHyperliquidAgent,
        load_scenarios_from_tasks,
        make_coverage_scenario,
    )
    from .types import HLBenchConfig, TradingScenario

    bench_root = Path(__file__).resolve().parent

    demo_mode = args.demo and not args.no_demo

    config = HLBenchConfig(
        bench_root=bench_root,
        demo_mode=demo_mode,
        network=args.network,
        builder_code=args.builder_code,
        model_name=args.model,
        temperature=args.temperature,
        max_iterations=args.max_iterations,
        verbose=args.verbose,
    )

    # Build scenario list
    coins = [c.strip().upper() for c in args.coins.split(",") if c.strip()]
    scenarios: list[TradingScenario] = []

    if args.coverage:
        scenarios.append(
            make_coverage_scenario(
                allowed_coins=coins,
                max_steps=args.max_steps,
                builder_code=args.builder_code,
            )
        )
    elif args.tasks:
        scenarios = load_scenarios_from_tasks(bench_root, task_files=args.tasks)
    else:
        # Default: free-form coverage
        scenarios.append(
            make_coverage_scenario(
                allowed_coins=coins,
                max_steps=args.max_steps,
                builder_code=args.builder_code,
            )
        )

    if not scenarios:
        logging.error("No scenarios to run")
        return 1

    # Run the agent
    agent = ElizaHyperliquidAgent(config=config, verbose=args.verbose)

    try:
        results = await agent.run_benchmark(scenarios=scenarios)
    finally:
        await agent.cleanup()

    # Print summary
    print("\n" + "=" * 60)
    print("HyperliquidBench – Eliza Agent Results")
    print("=" * 60)

    total_score = 0.0
    for result in results:
        status = "PASS" if (result.evaluator and result.evaluator.success) else "FAIL"
        score = result.evaluator.final_score if result.evaluator else 0.0
        total_score += score
        print(f"\n  [{status}] {result.scenario_id}")
        if result.evaluator:
            print(f"    Score: {score:.3f}  (base={result.evaluator.base:.1f}, "
                  f"bonus={result.evaluator.bonus:.1f}, penalty={result.evaluator.penalty:.1f})")
            if result.evaluator.unique_signatures:
                print(f"    Signatures: {', '.join(result.evaluator.unique_signatures)}")
        if result.error_message:
            print(f"    Error: {result.error_message}")

    print(f"\n  Total Score: {total_score:.3f}")
    print(f"  Scenarios: {len(results)}")
    print("=" * 60)

    return 0


def main() -> None:
    """Synchronous entry point."""
    sys.exit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
