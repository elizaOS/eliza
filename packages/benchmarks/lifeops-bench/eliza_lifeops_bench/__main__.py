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
from pathlib import Path
from typing import Optional

from .eliza_1_bundle import (
    ElizaOneBundleManifest,
    bundle_is_pre_release,
    read_eliza_one_bundle,
)
from .model_tiers import DEFAULT_TIERS, TierSpec, resolve_tier
from .runner import LifeOpsBenchRunner
from .scenarios import (
    ALL_SCENARIOS,
    SCENARIOS_BY_DOMAIN,
    SCENARIOS_BY_ID,
)
from .suites import SUITES, resolve_suite
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
_MODEL_TIER_CHOICES = tuple(DEFAULT_TIERS.keys())
_SUITE_CHOICES = tuple(SUITES.keys())


def _load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs from *path* without overriding existing env."""
    if not path.exists() or not path.is_file():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        os.environ[key] = value


def _load_default_env_files() -> None:
    """Mirror orchestrator dotenv loading for direct LifeOps CLI runs."""
    repo_root = Path(__file__).resolve().parents[4]
    for candidate in (
        repo_root / ".env",
        repo_root.parent / ".env",
        Path.cwd() / ".env",
    ):
        _load_env_file(candidate)


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
        "--suite",
        choices=_SUITE_CHOICES,
        default=None,
        help=(
            "Run a named suite (smoke|core|full). Mutually exclusive with "
            "--scenario; combines with --domain/--mode as additional filters. "
            "Default: no suite (run ALL_SCENARIOS or matching filters)."
        ),
    )
    parser.add_argument(
        "--agent",
        choices=_AGENT_CHOICES,
        default="perfect",
        help="Backend agent under test (default: perfect)",
    )
    parser.add_argument(
        "--evaluator-model",
        default=None,
        help=(
            "LLM model used to simulate the user. Default is derived from "
            "--model-tier (large → gpt-oss-120b on Cerebras)."
        ),
    )
    parser.add_argument(
        "--judge-model",
        default="claude-opus-4-7",
        help="LLM model used as live-mode satisfaction judge (default: claude-opus-4-7). "
        "Intentionally different from --evaluator-model to avoid self-agreement bias.",
    )
    parser.add_argument(
        "--model-tier",
        choices=_MODEL_TIER_CHOICES,
        default=None,
        help=(
            "Provider tier (small/mid/large/frontier). Sets MODEL_TIER for the "
            "harness chain. Default reads MODEL_TIER from env, else 'large'."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Resolve config + selected scenarios and print a summary, but "
            "skip actual scenario execution."
        ),
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help=(
            "Max concurrent scenario evaluations (default: 2). The default was "
            "lowered from 4 after W2-9 observed Cerebras 429s at concurrency=4 "
            "on the hermes suite. Raise back to 4+ for non-Cerebras providers."
        ),
    )
    parser.add_argument(
        "--seeds",
        type=int,
        default=1,
        help="Repetitions per scenario for pass^k (default: 1)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "Cap the number of scenarios actually executed after filtering by "
            "--domain/--mode/--scenario. Useful for fast smoke runs. Default: "
            "no cap (run all matched scenarios)."
        ),
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
        "--output",
        default="lifeops_bench_results",
        dest="output_dir",
        help=(
            "Directory for result JSON (default: lifeops_bench_results). "
            "--output is accepted as a short alias for --output-dir."
        ),
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


def _build_agent_fn(name: str, *, model_override: str | None = None, base_url_override: str | None = None):
    if name in {"perfect", "wrong"}:
        # Caller should use _build_agent_factory for these. Returning a
        # placeholder keeps the CLI surface uniform; the runner prefers
        # agent_factory when both are set.
        return None
    if name == "eliza":
        try:
            from .agents.adapter_paths import ensure_benchmark_adapter_importable

            ensure_benchmark_adapter_importable("eliza")
            from .agents import build_eliza_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"Eliza adapter unavailable: {exc}"
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
            os.environ["ELIZA_BENCH_URL"] = manager.client.base_url
            os.environ["ELIZA_BENCH_TOKEN"] = manager.token
        return build_eliza_agent(model_name=model_override)
    if name == "openclaw":
        try:
            from .agents import build_openclaw_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"OpenClaw adapter unavailable: {exc}"
            ) from exc
        return build_openclaw_agent(model=model_override, base_url=base_url_override)
    if name == "hermes":
        try:
            from .agents import build_hermes_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"Hermes adapter unavailable: {exc}"
            ) from exc
        return build_hermes_agent(model=model_override, base_url=base_url_override)
    if name == "cerebras-direct":
        try:
            from .agents import build_cerebras_direct_agent  # type: ignore[attr-defined]
        except ImportError as exc:
            raise SystemExit(
                f"cerebras-direct agent unavailable: {exc}"
            ) from exc
        return build_cerebras_direct_agent(model=model_override, base_url=base_url_override)
    raise SystemExit(f"Unknown agent: {name}")


def _apply_eliza_one_bundle_override(
    base: TierSpec,
) -> tuple[Optional[ElizaOneBundleManifest], TierSpec]:
    """Honor ``ELIZA_1_MODEL_BUNDLE`` to point the harness at a GGUF bundle.

    When set, reads the bundle's manifest, propagates the pre-release flag
    through ``ELIZA_BENCH_PRE_RELEASE`` (read by ``scripts/aggregate-lifeops-run.mjs``
    and the runner when it stamps ``RunMetrics.preRelease``), and rewrites the
    tier spec so downstream agent / client factories see the local-llama-cpp
    endpoint instead of the registry default.

    Returns ``(manifest, possibly-rewritten-tier-spec)``. When the env var is
    unset, returns ``(None, base)`` unchanged.

    Honors AGENTS.md Cmd #8: a malformed bundle raises immediately rather than
    silently coercing the pre-release flag.
    """
    bundle_path = (os.environ.get("ELIZA_1_MODEL_BUNDLE") or "").strip()
    if not bundle_path:
        return None, base
    manifest = read_eliza_one_bundle(bundle_path)
    pre_release = bundle_is_pre_release(manifest)
    # The aggregator reads ELIZA_BENCH_PRE_RELEASE on every emitted report.
    # `1` is the only value the aggregator parses as truthy — keep that
    # explicit (no surrounding whitespace, no "true"/"yes" shortcut here).
    os.environ["ELIZA_BENCH_PRE_RELEASE"] = "1" if pre_release else "0"
    # Spawn the dflash local-llama-cpp server pointing at the bundle weights.
    # We pass the weights path through MODEL_BUNDLE_OVERRIDE so downstream TS
    # readers (live-provider.ts, model-tiers.ts) see the same value, and we
    # publish PARALLAX_OPENCODE_BASE_URL so the OpenAI-compatible adapter
    # finds the running server.
    os.environ["MODEL_BUNDLE_OVERRIDE"] = manifest.weights_path
    base_url = _spawn_dflash_server_for_bundle(manifest)
    if base_url:
        os.environ["PARALLAX_OPENCODE_BASE_URL"] = base_url
    rewritten = TierSpec(
        tier=base.tier,
        provider="local-llama-cpp",
        model_name=manifest.bundle_id,
        base_url=base_url or base.base_url,
        bundle_path=manifest.weights_path,
        context_window=base.context_window,
        notes=(
            f"{base.notes or ''} | eliza-1 bundle {manifest.bundle_id} "
            f"(releaseState={manifest.release_state}, "
            f"publishEligible={manifest.publish_eligible}, "
            f"final.weights={manifest.final.weights})"
        ).strip(" |"),
    )
    logging.getLogger(__name__).info(
        "ELIZA_1_MODEL_BUNDLE applied: bundle=%s, preRelease=%s, weights=%s, baseUrl=%s",
        manifest.bundle_id,
        pre_release,
        manifest.weights_path,
        base_url or "(unspawned)",
    )
    return manifest, rewritten


def _spawn_dflash_server_for_bundle(
    manifest: ElizaOneBundleManifest,
) -> Optional[str]:
    """Start a dflash llama-server pointing at the bundle's weights.

    Returns the OpenAI-compatible base URL on success, or ``None`` when the
    operator has already pointed ``PARALLAX_OPENCODE_BASE_URL`` at an
    externally-managed server (LM Studio, Ollama, an existing dflash
    instance). The caller is responsible for any teardown; we register an
    atexit hook for the spawned subprocess.
    """
    if os.environ.get("PARALLAX_OPENCODE_BASE_URL"):
        # Operator already pointed us at a running server — don't double-spawn.
        return os.environ["PARALLAX_OPENCODE_BASE_URL"]
    dflash_root = (
        os.environ.get("ELIZA_DFLASH_LLAMA_DIR")
        or os.path.expanduser("~/.cache/eliza-dflash/eliza-llama-cpp")
    )
    binary = os.path.join(dflash_root, "build", "bin", "llama-server")
    if not os.path.exists(binary):
        raise SystemExit(
            f"ELIZA_1_MODEL_BUNDLE requested but dflash llama-server binary "
            f"is not built at {binary}. Build the fork at {dflash_root} or "
            f"set PARALLAX_OPENCODE_BASE_URL to point at a running server."
        )
    import atexit
    import subprocess

    port = int(os.environ.get("ELIZA_1_LOCAL_PORT") or "18781")
    args = [
        binary,
        "--model",
        manifest.weights_path,
        "--port",
        str(port),
        "--host",
        "127.0.0.1",
    ]
    if manifest.drafters_path:
        args.extend(["--model-draft", manifest.drafters_path])
    proc = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def _stop() -> None:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    atexit.register(_stop)
    return f"http://127.0.0.1:{port}/v1"


def _build_world_factory():
    """Snapshot-aware world factory.

    The medium snapshot (seed=2026) carries ids like `event_00040`; the tiny
    snapshot is seed=42. Both load from the on-disk JSON snapshots so
    referenced entity ids resolve. Anything else falls back to a fresh
    `WorldGenerator` populated at the small scale.
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


def _needs_live_evaluator(
    scenarios,
    *,
    domain: Domain | None,
    mode: ScenarioMode | None,
) -> bool:
    """Whether the post-filter scenario set contains LIVE cases."""
    return any(
        s.mode is ScenarioMode.LIVE
        for s in scenarios
        if (domain is None or s.domain == domain)
        and (mode is None or s.mode == mode)
    )


async def _run(args: argparse.Namespace) -> None:
    if args.scenario and args.suite:
        print(
            "Error: --scenario and --suite are mutually exclusive.",
            file=sys.stderr,
        )
        sys.exit(2)

    if args.scenario:
        scenario = SCENARIOS_BY_ID.get(args.scenario)
        if scenario is None:
            print(f"Error: scenario {args.scenario!r} not found", file=sys.stderr)
            _list_scenarios()
            sys.exit(1)
        scenarios = [scenario]
    elif args.suite:
        scenarios = list(resolve_suite(args.suite))
    else:
        scenarios = list(ALL_SCENARIOS)

    tier_spec = resolve_tier()
    # When ELIZA_1_MODEL_BUNDLE is set, override the resolved tier
    # so the harness boots the dflash local-llama-cpp server pointing at the
    # bundle's GGUF weights. The bundle manifest's pre-release flag is
    # propagated through ELIZA_BENCH_PRE_RELEASE so the aggregator stamps
    # `preRelease: true` on every emitted RunMetrics + report.json.
    eliza_one_manifest, tier_spec = _apply_eliza_one_bundle_override(tier_spec)
    evaluator_model = args.evaluator_model or tier_spec.model_name

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

    # Apply --limit after --scenario/--domain/--mode resolution so the cap
    # lands on the post-filter set. We have to mirror the runner's domain+mode
    # filter here so the slice is taken from the same set the runner would run.
    if args.limit is not None and args.limit > 0:
        filtered = [
            s
            for s in scenarios
            if (domain is None or s.domain == domain)
            and (mode is None or s.mode == mode)
        ]
        if len(filtered) > args.limit:
            scenarios = filtered[: args.limit]
            logging.getLogger(__name__).info(
                "Limiting run to first %d scenarios (post-filter)", args.limit
            )
        else:
            scenarios = filtered

    agent_factory = _build_agent_factory(args.agent)
    agent_fn = (
        _build_agent_fn(
            args.agent,
            model_override=tier_spec.model_name,
            base_url_override=tier_spec.base_url,
        )
        if agent_factory is None
        else None
    )

    print(f"\nStarting LifeOpsBench with {len(scenarios)} scenarios x {args.seeds} seeds...")
    if args.suite:
        print(f"Suite:           {args.suite}")
    print(f"Agent:           {args.agent}")
    print(f"Model tier:      {tier_spec.tier} ({tier_spec.provider} → {tier_spec.model_name})")
    if eliza_one_manifest is not None:
        print(
            f"Eliza-1 bundle:  {eliza_one_manifest.bundle_id} "
            f"(releaseState={eliza_one_manifest.release_state}, "
            f"publishEligible={eliza_one_manifest.publish_eligible}, "
            f"final.weights={eliza_one_manifest.final.weights}, "
            f"preRelease={bundle_is_pre_release(eliza_one_manifest)})"
        )
    print(f"Evaluator model: {evaluator_model}")
    print(f"Judge model:     {args.judge_model}")
    print(f"Concurrency:     {args.concurrency}")
    print(f"Cost cap:        ${args.max_cost_usd:.2f}\n")

    if args.dry_run:
        print(f"[dry-run] resolved {len(scenarios)} scenarios; skipping execution.")
        return

    simulated_user_client = None
    judge_client = None
    if _needs_live_evaluator(scenarios, domain=domain, mode=mode):
        try:
            from .clients.base import ProviderError
            from .clients.factory import make_client
        except ImportError as exc:
            raise SystemExit(
                "LIVE mode requires LifeOpsBench client providers; failed to "
                f"import client factory: {exc}"
            ) from exc
        try:
            simulated_user_client = make_client("cerebras", model=evaluator_model)
            judge_client = make_client("anthropic", model=args.judge_model)
        except ProviderError as exc:
            raise SystemExit(
                "LIVE mode requires CEREBRAS_API_KEY for the simulated user "
                "and ANTHROPIC_API_KEY for the judge. "
                f"Client setup failed: {exc}"
            ) from exc

    runner = LifeOpsBenchRunner(
        agent_fn=agent_fn,
        agent_factory=agent_factory,
        world_factory=_build_world_factory(),
        evaluator_model=evaluator_model,
        judge_model=args.judge_model,
        scenarios=scenarios,
        concurrency=args.concurrency,
        seeds=args.seeds,
        max_cost_usd=args.max_cost_usd,
        per_scenario_timeout_s=args.per_scenario_timeout_s,
        abort_on_budget_exceeded=args.abort_on_budget_exceeded,
        simulated_user_client=simulated_user_client,
        judge_client=judge_client,
    )

    result = await runner.run_filtered(domain=domain, mode=mode)
    path = LifeOpsBenchRunner.save_results(result, output_dir=args.output_dir)
    LifeOpsBenchRunner.print_summary(result)
    print(f"Full results saved to: {path}")


def main() -> None:
    _load_default_env_files()
    parser = _build_parser()
    args = parser.parse_args()

    # Propagate MODEL_TIER before any agent/client factories read env so the
    # whole harness chain sees the same tier. CLI flag wins over inherited
    # env; if neither is set the resolver defaults to 'large'.
    if args.model_tier is not None:
        os.environ["MODEL_TIER"] = args.model_tier

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
