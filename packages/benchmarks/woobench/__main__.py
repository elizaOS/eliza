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
import sys
from typing import Any

from .runner import WooBenchRunner
from .scenarios import ALL_SCENARIOS, SCENARIOS_BY_SYSTEM, SCENARIOS_BY_ARCHETYPE


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
        choices=["dummy", "eliza"],
        default="dummy",
        help=(
            "Agent under test. 'dummy' returns a fixed string (smoke test), "
            "'eliza' drives the full ElizaOS message_service.handle_message "
            "pipeline (provider chosen by WOOBENCH_AGENT_PROVIDER env, "
            "default groq)."
        ),
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


def _build_eliza_agent_fn():
    """Construct an agent_fn backed by a real ElizaOS AgentRuntime.

    Returns an async callable matching ``Callable[[list[dict[str,str]]], str]``
    that drives ``runtime.message_service.handle_message`` for each turn.

    The runtime is created lazily on first invocation so a dry-run / list
    command never spins it up.
    """
    import os
    import uuid as _uuid
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.memory import Memory
    from elizaos.types.primitives import Content, as_uuid

    state: dict[str, object] = {"runtime": None, "room_id": None, "entity_id": None}

    async def _ensure_runtime() -> AgentRuntime:
        rt = state.get("runtime")
        if rt is not None:
            return rt  # type: ignore[return-value]

        plugins: list[object] = []
        from elizaos_plugin_sql import sql_plugin

        plugins.append(sql_plugin)

        provider = (os.environ.get("WOOBENCH_AGENT_PROVIDER", "groq")).strip().lower()
        if provider == "groq":
            if not os.environ.get("GROQ_API_KEY"):
                raise RuntimeError(
                    "GROQ_API_KEY not set; required for WooBench groq agent provider"
                )
            from elizaos_plugin_groq import get_groq_plugin

            plugins.append(get_groq_plugin())
        elif provider == "openai":
            if not os.environ.get("OPENAI_API_KEY"):
                raise RuntimeError("OPENAI_API_KEY not set for openai provider")
            from elizaos_plugin_openai import get_openai_plugin

            plugins.append(get_openai_plugin())
        else:
            raise RuntimeError(f"Unsupported WOOBENCH_AGENT_PROVIDER={provider!r}")

        character = Character(
            name="Mystic-Reader",
            bio=[
                "A skilled mystical reading agent.",
                "Conducts tarot, I Ching, and astrology readings.",
            ],
            system=(
                "You are a mystical reader providing personalized divination "
                "readings. Listen carefully, respond thoughtfully, and build "
                "rapport. Be empathetic and use intuitive insight."
            ),
        )

        runtime = AgentRuntime(
            character=character,
            plugins=plugins,
            log_level="WARNING",
            check_should_respond=False,
        )
        await runtime.initialize()
        state["runtime"] = runtime
        state["room_id"] = str(_uuid.uuid4())
        state["entity_id"] = str(_uuid.uuid4())
        return runtime

    async def _agent_fn(conversation_history: list[dict[str, str]]) -> str:
        runtime = await _ensure_runtime()
        last_user = next(
            (
                turn["content"]
                for turn in reversed(conversation_history)
                if turn.get("role") == "user"
            ),
            "",
        )
        if not last_user:
            return ""

        room_id = state["room_id"]
        entity_id = state["entity_id"]
        message = Memory(
            id=as_uuid(str(_uuid.uuid4())),
            entity_id=as_uuid(str(entity_id)),
            room_id=as_uuid(str(room_id)),
            content=Content(text=str(last_user)),
        )
        result = await runtime.message_service.handle_message(runtime, message, None)
        if result.response_content is not None and result.response_content.text:
            return str(result.response_content.text)
        return ""

    return _agent_fn


async def _run(args: argparse.Namespace) -> None:
    """Execute the benchmark run."""

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
    if args.agent == "eliza":
        agent_fn = _build_eliza_agent_fn()
    else:
        agent_fn = _create_dummy_agent
    runner = WooBenchRunner(
        agent_fn=agent_fn,
        evaluator_model=args.model,
        scenarios=scenarios,
        concurrency=args.concurrency,
    )

    print(f"\nStarting WooBench with {len(runner.scenarios)} scenarios...")
    print(f"Evaluator model: {args.model}")
    print(f"Concurrency: {args.concurrency}\n")

    result = await runner.run_all()

    # Save and display
    filepath = WooBenchRunner.save_results(result, output_dir=args.output)
    WooBenchRunner.print_summary(result)
    print(f"Full results saved to: {filepath}")


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
