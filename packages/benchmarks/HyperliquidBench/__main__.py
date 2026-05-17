"""
CLI entry point for HyperliquidBench.

Two modes are supported via ``--mode``:

* ``eliza`` (default) — routes plan generation through the eliza TypeScript benchmark
  server via ``eliza_adapter.hyperliquid.ElizaHyperliquidAgent``. The Rust
  execution path (``hl-runner`` + ``hl-evaluator``) is reused unchanged.
* ``deterministic`` / ``python`` — local deterministic demo plan generation,
  retained for smoke tests and offline harness validation.

Examples:
    # Eliza TS bridge, demo (starts the benchmark server automatically)
    python -m benchmarks.HyperliquidBench --demo

    # Free-form coverage scenario with specific coins
    python -m benchmarks.HyperliquidBench --coins ETH,BTC,SOL --max-steps 7

    # Run scenarios from task files
    python -m benchmarks.HyperliquidBench --tasks hl_perp_basic_01.jsonl

    # Live testnet (requires HL_PRIVATE_KEY)
    python -m benchmarks.HyperliquidBench --network testnet --no-demo
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

# Ensure the eliza-adapter package is importable for the eliza TS bridge mode.
_ELIZA_ADAPTER_PKG = Path(__file__).resolve().parents[1] / "eliza-adapter"
if _ELIZA_ADAPTER_PKG.exists() and str(_ELIZA_ADAPTER_PKG) not in sys.path:
    sys.path.insert(0, str(_ELIZA_ADAPTER_PKG))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="benchmarks.HyperliquidBench",
        description="Run HyperliquidBench scenarios through an Eliza agent",
    )

    # Mode selection: bridge-backed Eliza by default; deterministic local path
    # remains for offline smoke tests.
    parser.add_argument(
        "--mode",
        type=str,
        default="eliza",
        choices=["eliza", "deterministic", "python"],
        help=(
            "Agent backend. 'eliza' routes plan generation through the eliza "
            "TypeScript benchmark server via eliza_adapter.hyperliquid (default). "
            "'deterministic'/'python' use the local deterministic smoke agent."
        ),
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
        default=None,
        help=(
            "Model name for plan generation. Defaults to openai/gpt-oss-120b."
        ),
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
        "--output",
        "--output-dir",
        dest="output",
        type=str,
        default=None,
        help=(
            "Directory to write the aggregated result JSON file. "
            "Defaults to <bench_root>/runs."
        ),
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        default=False,
        help="Enable verbose/debug logging",
    )

    return parser.parse_args()


def _build_results_summary(results: list[object]) -> dict[str, object]:
    """Aggregate per-scenario results into the JSON the registry will read."""
    scenarios_out: list[dict[str, object]] = []
    total_score = 0.0
    total_base = 0.0
    total_bonus = 0.0
    total_penalty = 0.0
    passed = 0

    for result in results:
        evaluator = getattr(result, "evaluator", None)
        runner = getattr(result, "runner", None)
        scenario_id = getattr(result, "scenario_id", "")
        error_message = getattr(result, "error_message", None)

        success = bool(evaluator and getattr(evaluator, "success", False))
        score = float(getattr(evaluator, "final_score", 0.0)) if evaluator else 0.0
        base = float(getattr(evaluator, "base", 0.0)) if evaluator else 0.0
        bonus = float(getattr(evaluator, "bonus", 0.0)) if evaluator else 0.0
        penalty = float(getattr(evaluator, "penalty", 0.0)) if evaluator else 0.0
        sigs = list(getattr(evaluator, "unique_signatures", [])) if evaluator else []
        out_dir = getattr(runner, "out_dir", "") if runner else ""

        if success:
            passed += 1

        total_score += score
        total_base += base
        total_bonus += bonus
        total_penalty += penalty

        scenarios_out.append({
            "scenario_id": scenario_id,
            "success": success,
            "final_score": score,
            "base": base,
            "bonus": bonus,
            "penalty": penalty,
            "unique_signatures": sigs,
            "out_dir": out_dir,
            "error": error_message,
        })

    n = max(len(results), 1)
    return {
        "benchmark": "hyperliquid_bench",
        "scenarios": scenarios_out,
        "total_scenarios": len(results),
        "passed_scenarios": passed,
        "final_score": total_score / n,  # average per scenario
        "total_score": total_score,
        "base": total_base,
        "bonus": total_bonus,
        "penalty": total_penalty,
    }


async def _main() -> int:
    args = _parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Lazy imports so --help is fast
    from .eliza_agent import (
        load_scenarios_from_tasks,
        make_coverage_scenario,
    )
    from .types import HLBenchConfig, TradingScenario

    bench_root = Path(__file__).resolve().parent

    demo_mode = args.demo and not args.no_demo

    provider = os.environ.get("BENCHMARK_MODEL_PROVIDER", "").strip().lower()
    if not provider:
        if os.environ.get("GROQ_API_KEY"):
            provider = "groq"
        elif os.environ.get("OPENROUTER_API_KEY"):
            provider = "openrouter"
        elif os.environ.get("OPENAI_API_KEY"):
            provider = "openai"

    model_name = (args.model or os.environ.get("BENCHMARK_MODEL_NAME", "")).strip()
    if not model_name:
        model_name = "openai/gpt-oss-120b"

    if args.mode == "eliza":
        if provider:
            os.environ["BENCHMARK_MODEL_PROVIDER"] = provider
        os.environ["BENCHMARK_MODEL_NAME"] = model_name
        os.environ["OPENAI_LARGE_MODEL"] = model_name
        os.environ["OPENAI_SMALL_MODEL"] = model_name
        os.environ["GROQ_LARGE_MODEL"] = model_name
        os.environ["GROQ_SMALL_MODEL"] = model_name
        os.environ["OPENROUTER_LARGE_MODEL"] = model_name
        os.environ["OPENROUTER_SMALL_MODEL"] = model_name

    config = HLBenchConfig(
        bench_root=bench_root,
        demo_mode=demo_mode,
        network=args.network,
        builder_code=args.builder_code,
        model_name=model_name,
        temperature=args.temperature,
        max_iterations=args.max_iterations,
        verbose=args.verbose,
    )

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

    # Pick the agent backend.
    bridge_manager = None
    if args.mode == "eliza":
        from eliza_adapter.hyperliquid import ElizaHyperliquidAgent as _BridgeAgent
        from eliza_adapter.server_manager import ElizaServerManager

        bridge_manager = ElizaServerManager()
        bridge_manager.start()
        agent: object = _BridgeAgent(
            config=config,
            client=bridge_manager.client,
            verbose=args.verbose,
        )
        logging.info("Using eliza TS bridge agent (eliza_adapter.hyperliquid)")
    else:
        from .eliza_agent import ElizaHyperliquidAgent as _PythonAgent

        agent = _PythonAgent(config=config, verbose=args.verbose)
        logging.info("Using local deterministic HyperliquidBench smoke agent")

    try:
        results = await agent.run_benchmark(scenarios=scenarios)  # type: ignore[attr-defined]
    finally:
        try:
            await agent.cleanup()  # type: ignore[attr-defined]
        finally:
            if bridge_manager is not None:
                bridge_manager.stop()

    summary = _build_results_summary(results)
    summary["mode"] = args.mode
    summary["model"] = model_name
    summary["network"] = args.network
    summary["demo_mode"] = demo_mode

    # Write the aggregated result JSON in a location the registry can locate.
    output_dir = Path(args.output).resolve() if args.output else (bench_root / config.runs_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_file = output_dir / f"hyperliquid_bench-{args.mode}-{timestamp}.json"
    out_file.write_text(json.dumps(summary, indent=2))
    logging.info("Wrote aggregated results to %s", out_file)

    # Print the human summary on stdout.
    print("\n" + "=" * 60)
    print(f"HyperliquidBench — {args.mode} mode results")
    print("=" * 60)
    for scenario in summary["scenarios"]:  # type: ignore[union-attr]
        status = "PASS" if scenario["success"] else "FAIL"  # type: ignore[index]
        print(f"\n  [{status}] {scenario['scenario_id']}")  # type: ignore[index]
        print(
            f"    Score: {scenario['final_score']:.3f}  "  # type: ignore[index]
            f"(base={scenario['base']:.1f}, bonus={scenario['bonus']:.1f}, "
            f"penalty={scenario['penalty']:.1f})"
        )
        if scenario["unique_signatures"]:  # type: ignore[index]
            print(f"    Signatures: {', '.join(scenario['unique_signatures'])}")  # type: ignore[index]
        if scenario["error"]:  # type: ignore[index]
            print(f"    Error: {scenario['error']}")  # type: ignore[index]
    print(f"\n  Average final_score: {summary['final_score']:.3f}")
    print(f"  Scenarios: {summary['total_scenarios']}, Passed: {summary['passed_scenarios']}")
    print(f"  Result file: {out_file}")
    print("=" * 60)

    return 0


def main() -> None:
    """Synchronous entry point."""
    sys.exit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
