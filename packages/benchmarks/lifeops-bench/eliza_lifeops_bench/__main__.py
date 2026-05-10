"""CLI entry point for LifeOpsBench.

Usage::

    python -m eliza_lifeops_bench --help
    python -m eliza_lifeops_bench --agent perfect
    python -m eliza_lifeops_bench --domain calendar --mode static
    python -m eliza_lifeops_bench --scenario smoke_static_calendar_01 --seeds 3
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from .runner import LifeOpsBenchRunner
from .scenarios import (
    ALL_SCENARIOS,
    SCENARIOS_BY_DOMAIN,
    SCENARIOS_BY_ID,
)
from .types import Domain, MessageTurn, ScenarioMode

_AGENT_CHOICES = (
    "perfect",
    "wrong",
    "eliza",
    "openclaw",
    "hermes",
    "cerebras-direct",
)
_DOMAIN_CHOICES = tuple(d.value for d in Domain)
_MODE_CHOICES = tuple(m.value for m in ScenarioMode)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lifeops-bench",
        description="LifeOpsBench — multi-turn life-assistant tool-use benchmark",
    )
    parser.add_argument("--scenario", help="Run a single scenario by ID")
    parser.add_argument(
        "--domain",
        choices=_DOMAIN_CHOICES,
        help="Filter scenarios to a single domain",
    )
    parser.add_argument(
        "--mode",
        choices=_MODE_CHOICES,
        help="Filter scenarios to STATIC or LIVE mode",
    )
    parser.add_argument(
        "--agent",
        choices=_AGENT_CHOICES,
        default="perfect",
        help="Backend agent under test (default: perfect)",
    )
    parser.add_argument(
        "--evaluator-model",
        default="gpt-oss-120b",
        help="LLM model used to simulate the user (default: gpt-oss-120b on Cerebras)",
    )
    parser.add_argument(
        "--judge-model",
        default="claude-opus-4-7",
        help="LLM model used as live-mode satisfaction judge (default: claude-opus-4-7). "
        "Intentionally different from --evaluator-model to avoid self-agreement bias.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Max concurrent scenario evaluations (default: 4)",
    )
    parser.add_argument(
        "--seeds",
        type=int,
        default=1,
        help="Repetitions per scenario for pass^k (default: 1)",
    )
    parser.add_argument(
        "--max-cost-usd",
        type=float,
        default=10.0,
        help="Abort the run if cumulative spend exceeds this (default: 10.0)",
    )
    parser.add_argument(
        "--per-scenario-timeout-s",
        type=int,
        default=300,
        help="Per-scenario wall-clock timeout in seconds (default: 300)",
    )
    parser.add_argument(
        "--abort-on-budget-exceeded",
        dest="abort_on_budget_exceeded",
        action="store_true",
        default=True,
        help=(
            "When the cumulative cost cap (`--max-cost-usd`) is hit, mark "
            "every still-pending scenario as cost_exceeded and stop "
            "scheduling new agent / judge calls. Default: enabled."
        ),
    )
    parser.add_argument(
        "--no-abort-on-budget-exceeded",
        dest="abort_on_budget_exceeded",
        action="store_false",
        help=(
            "Keep running every scenario even after the cost cap is hit. "
            "Pending scenarios will still raise CostBudgetExceeded once they "
            "actually try to charge against the cap; this is mostly useful "
            "for debugging the ledger split."
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="lifeops_bench_results",
        help="Directory for result JSON (default: lifeops_bench_results)",
    )
    parser.add_argument(
        "--list-scenarios",
        action="store_true",
        help="List available scenarios and exit",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    return parser


def _list_scenarios() -> None:
    print("\nAvailable LifeOpsBench scenarios:")
    print("-" * 78)
    for s in ALL_SCENARIOS:
        print(
            f"  {s.id:<40} {s.domain.value:<10} {s.mode.value:<7} {s.name}"
        )
    print(f"\nTotal: {len(ALL_SCENARIOS)} scenarios\n")
    print("By domain:")
    for domain, scenarios in sorted(SCENARIOS_BY_DOMAIN.items(), key=lambda kv: kv[0].value):
        print(f"  {domain.value:<12} {len(scenarios)} scenarios")
    print()


def _build_agent_factory(name: str):
    """Per-scenario agents (perfect/wrong) need a fresh instance per scenario.

    Returns a `Callable[[Scenario], AgentFn]` for stateful scenario-bound
    agents, or None if the named agent is stateless and should use the
    singleton path via `_build_agent_fn`.
    """
    if name == "perfect":
        from .agents import PerfectAgent
        return lambda scenario: PerfectAgent(scenario)
    if name == "wrong":
        from .agents import WrongAgent
        return lambda scenario: WrongAgent(scenario)
    return None


def _build_agent_fn(name: str):
    if name in {"perfect", "wrong"}:
        # Caller should use _build_agent_factory for these. Returning a
        # placeholder keeps the CLI surface uniform; the runner prefers
        # agent_factory when both are set.
        return None
    if name == "eliza":
        try:
            from .agents import build_eliza_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"Eliza adapter not yet wired (Wave 2C): {exc}"
            ) from exc
        # Spawn the TS bench server when the operator hasn't pointed us at
        # a live one. The ServerManager registers an atexit hook to stop the
        # subprocess, so the CLI doesn't need explicit teardown.
        if not os.environ.get("ELIZA_BENCH_URL"):
            try:
                from eliza_adapter.server_manager import ElizaServerManager
            except ImportError as exc:
                raise SystemExit(
                    "Cannot auto-spawn the eliza bench server: "
                    "eliza_adapter.server_manager is unavailable. "
                    "Install eliza-adapter or set ELIZA_BENCH_URL to a running server."
                ) from exc
            manager = ElizaServerManager()
            manager.start()
            # Stash on module-state so the process keeps the reference alive.
            globals()["_ELIZA_SERVER_MANAGER"] = manager
            os.environ.setdefault("ELIZA_BENCH_URL", manager.client.base_url)
            os.environ.setdefault("ELIZA_BENCH_TOKEN", manager.token)
        return build_eliza_agent()
    if name == "openclaw":
        try:
            from .agents import build_openclaw_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"OpenClaw adapter not yet wired (Wave 2D): {exc}"
            ) from exc
        return build_openclaw_agent()
    if name == "hermes":
        try:
            from .agents import build_hermes_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"Hermes adapter not yet wired (Wave 2E): {exc}"
            ) from exc
        return build_hermes_agent()
    if name == "cerebras-direct":
        try:
            from .agents import build_cerebras_direct_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"cerebras-direct agent not yet wired (Wave 1E/2F): {exc}"
            ) from exc
        return build_cerebras_direct_agent()
    raise SystemExit(f"Unknown agent: {name}")


def _build_world_factory():
    """Snapshot-aware world factory.

    Wave 2A scenarios reference the medium snapshot (seed=2026, ids like
    `event_00040`); the tiny snapshot is seed=42. Both load from the on-disk
    JSON snapshots so referenced entity ids resolve. Anything else falls back
    to a fresh `WorldGenerator` populated at the small scale.
    """
    from .lifeworld import LifeWorld
    from .lifeworld.generators import WorldGenerator
    from .lifeworld.snapshots import SNAPSHOT_SPECS, build_world_for

    specs_by_seed = {spec.seed: spec for spec in SNAPSHOT_SPECS}

    def factory(seed: int, now_iso: str) -> LifeWorld:
        spec = specs_by_seed.get(seed)
        if spec is not None:
            return build_world_for(spec)
        return WorldGenerator(seed=seed, now_iso=now_iso).generate_default_world(
            scale="small"
        )

    return factory


async def _run(args: argparse.Namespace) -> None:
    if args.scenario:
        scenario = SCENARIOS_BY_ID.get(args.scenario)
        if scenario is None:
            print(f"Error: scenario {args.scenario!r} not found", file=sys.stderr)
            _list_scenarios()
            sys.exit(1)
        scenarios = [scenario]
    else:
        scenarios = list(ALL_SCENARIOS)

    domain = Domain(args.domain) if args.domain else None
    mode = ScenarioMode(args.mode) if args.mode else None

    # When the operator hasn't wired live-judge clients (no Cerebras +
    # Anthropic in env), LIVE scenarios will crash inside the runner. Default
    # to STATIC-only in that case so `--agent perfect` works out of the box.
    # Operator can opt back in with `--mode live` once they wire the clients.
    if mode is None and not (os.environ.get("CEREBRAS_API_KEY") and os.environ.get("ANTHROPIC_API_KEY")):
        mode = ScenarioMode.STATIC
        logging.getLogger(__name__).info(
            "No CEREBRAS_API_KEY+ANTHROPIC_API_KEY in env; restricting to STATIC scenarios. "
            "Pass --mode live to override (will need both keys for the live judge)."
        )

    agent_factory = _build_agent_factory(args.agent)
    agent_fn = _build_agent_fn(args.agent) if agent_factory is None else None

    runner = LifeOpsBenchRunner(
        agent_fn=agent_fn,
        agent_factory=agent_factory,
        world_factory=_build_world_factory(),
        evaluator_model=args.evaluator_model,
        judge_model=args.judge_model,
        scenarios=scenarios,
        concurrency=args.concurrency,
        seeds=args.seeds,
        max_cost_usd=args.max_cost_usd,
        per_scenario_timeout_s=args.per_scenario_timeout_s,
        abort_on_budget_exceeded=args.abort_on_budget_exceeded,
    )

    print(f"\nStarting LifeOpsBench with {len(scenarios)} scenarios x {args.seeds} seeds...")
    print(f"Agent:           {args.agent}")
    print(f"Evaluator model: {args.evaluator_model}")
    print(f"Judge model:     {args.judge_model}")
    print(f"Concurrency:     {args.concurrency}")
    print(f"Cost cap:        ${args.max_cost_usd:.2f}\n")

    result = await runner.run_filtered(domain=domain, mode=mode)
    path = LifeOpsBenchRunner.save_results(result, output_dir=args.output_dir)
    LifeOpsBenchRunner.print_summary(result)
    print(f"Full results saved to: {path}")


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if args.list_scenarios:
        _list_scenarios()
        return

    asyncio.run(_run(args))


if __name__ == "__main__":
    main()


# Re-export so `from eliza_lifeops_bench.__main__ import MessageTurn` works for
# downstream agents that want the chat type without crossing the package root.
__all__ = ["MessageTurn", "main"]
