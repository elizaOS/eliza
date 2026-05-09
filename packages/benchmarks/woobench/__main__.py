"""CLI entry point for WooBench.

Usage::

    python -m benchmarks.woobench --help
    python -m benchmarks.woobench --system tarot
    python -m benchmarks.woobench --persona skeptic
    python -m benchmarks.woobench --scenario skeptic_tarot_01
    python -m benchmarks.woobench --model gpt-5 --output results/
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
from typing import Any

from .runner import WooBenchRunner
from .scenarios import ALL_SCENARIOS, SCENARIOS_BY_SYSTEM, SCENARIOS_BY_ARCHETYPE


def _configure_bridge_model_env(model: str) -> None:
    if not model:
        return
    for key in (
        "BENCHMARK_MODEL_NAME",
        "MODEL_NAME",
        "SMALL_MODEL",
        "LARGE_MODEL",
        "GROQ_SMALL_MODEL",
        "GROQ_LARGE_MODEL",
        "OPENAI_SMALL_MODEL",
        "OPENAI_LARGE_MODEL",
        "OPENROUTER_SMALL_MODEL",
        "OPENROUTER_LARGE_MODEL",
    ):
        os.environ.setdefault(key, model)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="woobench",
        description="WooBench -- Mystical Reading Agent Benchmark",
    )
    parser.add_argument(
        "--system",
        choices=["tarot", "iching", "astrology"],
        help="Run scenarios for a specific divination system",
    )
    parser.add_argument(
        "--persona",
        help="Run scenarios for a specific persona archetype "
        "(e.g. skeptic, true_believer)",
    )
    parser.add_argument(
        "--scenario",
        help="Run a single scenario by ID (e.g. skeptic_tarot_01)",
    )
    parser.add_argument(
        "--model",
        default="gpt-5",
        help="Evaluator model name (default: gpt-5)",
    )
    parser.add_argument(
        "--output",
        default="benchmark_results",
        help="Output directory for results (default: benchmark_results)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Max concurrent scenario evaluations (default: 4)",
    )
    parser.add_argument(
        "--list-scenarios",
        action="store_true",
        help="List all available scenarios and exit",
    )
    parser.add_argument(
        "--list-personas",
        action="store_true",
        help="List all available persona archetypes and exit",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be run without executing",
    )
    parser.add_argument(
        "--agent",
        choices=["dummy", "dummy-charge", "eliza"],
        default="eliza",
        help=(
            "Agent under test. 'dummy' returns a fixed string (smoke test only). "
            "'dummy-charge' calls the WooBench charge action for a configurable payment. "
            "'eliza' (default) routes through the elizaOS TS benchmark server "
            "(ELIZA_BENCH_URL / ELIZA_BENCH_TOKEN, auto-spawned if unset)."
        ),
    )
    parser.add_argument(
        "--dummy-charge-amount",
        type=float,
        default=1.0,
        help="USD amount requested by --agent dummy-charge. Defaults to 1.00.",
    )
    parser.add_argument(
        "--dummy-charge-provider",
        choices=["oxapay", "stripe"],
        default="oxapay",
        help="Payment provider requested by --agent dummy-charge. Defaults to oxapay.",
    )
    parser.add_argument(
        "--evaluator",
        choices=["llm", "heuristic"],
        default="llm",
        help=(
            "Evaluator mode. 'llm' uses the configured OpenAI-compatible "
            "judge. 'heuristic' is deterministic and intended for local "
            "smoke tests without provider credentials."
        ),
    )
    parser.add_argument(
        "--payment-mock-url",
        default=os.environ.get("WOO_BENCH_PAYMENT_MOCK_URL")
        or os.environ.get("ELIZA_MOCK_PAYMENT_BASE")
        or os.environ.get("ELIZA_MOCK_PAYMENTS_BASE"),
        help=(
            "Optional payments mock base URL. When set, paid persona turns "
            "create and accept real mock payment requests."
        ),
    )
    parser.add_argument(
        "--random-seed",
        type=int,
        help="Optional random seed for deterministic local smoke runs.",
    )
    return parser


def _list_scenarios() -> None:
    """Print all available scenarios."""
    print("\nAvailable WooBench Scenarios:")
    print("-" * 70)
    for scenario in ALL_SCENARIOS:
        print(
            f"  {scenario.id:<35} "
            f"{scenario.system.value:<10} "
            f"{scenario.persona.archetype.value:<18} "
            f"{scenario.name}"
        )
    print(f"\nTotal: {len(ALL_SCENARIOS)} scenarios\n")


def _list_personas() -> None:
    """Print all available persona archetypes."""
    print("\nAvailable Persona Archetypes:")
    print("-" * 40)
    for archetype, scenarios in sorted(SCENARIOS_BY_ARCHETYPE.items()):
        print(f"  {archetype:<20} ({len(scenarios)} scenarios)")
    print()


async def _create_dummy_agent(
    conversation_history: list[dict[str, str]],
) -> str:
    """A placeholder agent for dry runs and testing.

    Replace this with the actual agent under test.
    """
    return (
        "I sense a period of transformation and growth in your life. "
        "The energies around you suggest that change is coming, and with it, "
        "new opportunities. What areas of your life feel most in flux right now?"
    )


def _create_dummy_charge_agent(
    *,
    amount_usd: float,
    provider: str,
):
    """Build a smoke-test agent that calls the charge action before reading."""

    normalized_amount = round(max(amount_usd, 0.01), 2)

    async def agent(conversation_history: list[dict[str, str]]) -> dict[str, object] | str:
        user_text = "\n".join(
            turn["content"] for turn in conversation_history if turn.get("role") == "user"
        ).lower()
        if "payment sent" not in user_text and "went through" not in user_text:
            return {
                "text": (
                    f"I can do a focused reading for ${normalized_amount:.2f}. "
                    "Once that crypto charge goes through, I will continue with "
                    "the full interpretation."
                ),
                "actions": ["BENCHMARK_ACTION"],
                "params": {
                    "BENCHMARK_ACTION": {
                        "command": "CREATE_APP_CHARGE",
                        "amount_usd": normalized_amount,
                        "provider": provider,
                        "description": f"WooBench ${normalized_amount:.2f} reading",
                    }
                },
            }
        return (
            "Payment went through. I see a reading about growth, money, practical "
            "planning, and courage. The guidance is to honor the vision while "
            "building the concrete plan underneath it."
        )

    return agent




async def _run(args: argparse.Namespace) -> None:
    """Execute the benchmark run."""
    if args.random_seed is not None:
        random.seed(args.random_seed)

    # Select scenarios
    scenarios = None
    if args.scenario:
        from .scenarios import SCENARIOS_BY_ID
        s = SCENARIOS_BY_ID.get(args.scenario)
        if s is None:
            print(f"Error: Scenario '{args.scenario}' not found.", file=sys.stderr)
            _list_scenarios()
            sys.exit(1)
        scenarios = [s]
    elif args.system:
        scenarios = SCENARIOS_BY_SYSTEM.get(args.system)
        if not scenarios:
            print(f"Error: No scenarios for system '{args.system}'.", file=sys.stderr)
            sys.exit(1)
    elif args.persona:
        scenarios = SCENARIOS_BY_ARCHETYPE.get(args.persona)
        if not scenarios:
            print(f"Error: No scenarios for persona '{args.persona}'.", file=sys.stderr)
            _list_personas()
            sys.exit(1)

    # Dry run
    if args.dry_run:
        target = scenarios or ALL_SCENARIOS
        print(f"\nDry run -- would execute {len(target)} scenarios:")
        for s in target:
            print(f"  {s.id} ({s.system.value} / {s.persona.archetype.value})")
        print()
        return

    # Build runner
    server_manager = None
    if args.agent == "eliza":
        _configure_bridge_model_env(args.model)
        client = None
        if not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager

            server_manager = ElizaServerManager()
            server_manager.start()
            client = server_manager.client
        from eliza_adapter.woobench import build_eliza_bridge_agent_fn

        agent_fn = build_eliza_bridge_agent_fn(client=client, model_name=args.model)
    elif args.agent == "dummy-charge":
        agent_fn = _create_dummy_charge_agent(
            amount_usd=args.dummy_charge_amount,
            provider=args.dummy_charge_provider,
        )
    else:
        agent_fn = _create_dummy_agent
    payment_client = None
    if args.payment_mock_url:
        from .payment_mock import MockPaymentClient

        payment_client = MockPaymentClient(args.payment_mock_url)
    runner = WooBenchRunner(
        agent_fn=agent_fn,
        evaluator_model=args.model,
        evaluator_mode=args.evaluator,
        scenarios=scenarios,
        concurrency=args.concurrency,
        payment_client=payment_client,
    )

    print(f"\nStarting WooBench with {len(runner.scenarios)} scenarios...")
    print(f"Evaluator model: {args.model}")
    print(f"Evaluator mode: {args.evaluator}")
    if args.payment_mock_url:
        print(f"Payment mock: {args.payment_mock_url}")
    print(f"Concurrency: {args.concurrency}\n")

    result = await runner.run_all()

    # Save and display
    filepath = WooBenchRunner.save_results(result, output_dir=args.output)
    WooBenchRunner.print_summary(result)
    print(f"Full results saved to: {filepath}")
    if server_manager is not None:
        server_manager.stop()


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    # Configure logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    # Handle list commands
    if args.list_scenarios:
        _list_scenarios()
        return
    if args.list_personas:
        _list_personas()
        return

    # Run benchmark
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
