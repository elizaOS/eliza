"""Build the per-lane ``agent_factory`` + ``world_factory`` for each harness.

MultitaskBench's claim is "one long-lived agent handling N tasks", so every
harness builds a factory that shares one long-lived client across the N tasks
of a lane while giving each task its own ``agent_fn`` (its own session). The
harnesses differ only in isolation, which the report discloses:

- **eliza** — one ``ElizaClient`` (one bench-server / AgentRuntime) shared
  across the lane; each task's ``build_lifeops_bench_agent_fn`` mints a fresh
  ``lifeops-<uuid>`` session on it. Interference is real: N sessions contend
  for one runtime. Per-session usage attribution depends on the AsyncLocalStorage
  fix in ``packages/lifeops-bench/src/server.ts`` (issue #13777 PR 1); until
  that lands, the eliza live lane double-counts turn usage across overlapping
  sessions and must not be published — the CLI gates it behind
  ``MULTITASK_ELIZA_USAGE_FIX=1``.
- **hermes / openclaw** — one client shared across the lane, each task's
  ``agent_fn`` driving a per-turn subprocess/in-process call. Process-isolated;
  interference is only the shared rate/cost budget.

The hermetic ``perfect`` / ``wrong`` factories need no client and no keys —
they are the conformance path the tests and no-key smoke runs use, and they
carry ``isolation`` "shared_runtime" only nominally (there is no runtime; the
oracle is pure).
"""

from __future__ import annotations

import os
from collections.abc import Callable

from eliza_lifeops_bench.agents import DEFAULT_NOW_ISO, _resolve_default_snapshot_path
from eliza_lifeops_bench.agents.adapter_paths import (
    ensure_benchmark_adapter_importable,
)
from eliza_lifeops_bench.runner import AgentFactory, AgentFn, WorldFactory
from eliza_lifeops_bench.types import Scenario

__all__ = [
    "HARNESS_ISOLATION",
    "build_agent_factory",
    "build_world_factory",
]

# Nominal isolation per harness id. The hermetic oracles report as a shared
# runtime because they carry no per-turn process boundary, but they are not a
# live claim — the registry scorer rejects oracle-model reports.
HARNESS_ISOLATION: dict[str, str] = {
    "eliza": "shared_runtime",
    "hermes": "process_per_turn",
    "openclaw": "process_per_turn",
    "perfect": "shared_runtime",
    "wrong": "shared_runtime",
}


def build_world_factory() -> WorldFactory:
    """Snapshot-aware world factory (seed 2026 → medium snapshot, else fresh).

    Reuses ``eliza_lifeops_bench.__main__._build_world_factory`` so the world
    the multitask lane runs against is byte-identical to the one the single-task
    LifeOpsBench lane uses — the interference delta only means something if the
    two lanes score the same world.
    """
    from eliza_lifeops_bench.__main__ import _build_world_factory

    return _build_world_factory()


def _perfect_factory() -> AgentFactory:
    from eliza_lifeops_bench.agents import PerfectAgent

    return lambda scenario: PerfectAgent(scenario)


def _wrong_factory() -> AgentFactory:
    from eliza_lifeops_bench.agents import WrongAgent

    return lambda scenario: WrongAgent(scenario)


def _eliza_factory(model: str | None) -> AgentFactory:
    """One shared ElizaClient; each task gets its own session on the runtime.

    The client is constructed once and closed over, so the lane's N tasks all
    drive the same bench-server / AgentRuntime — the shared-runtime interference
    MultitaskBench is measuring.
    """
    ensure_benchmark_adapter_importable("eliza")
    from eliza_adapter.client import ElizaClient
    from eliza_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    if not os.environ.get("ELIZA_BENCH_URL"):
        from eliza_adapter.server_manager import ElizaServerManager

        manager = ElizaServerManager()
        manager.start()
        # Keep a reference alive for the process lifetime; the manager
        # registers its own atexit teardown.
        globals()["_ELIZA_SERVER_MANAGER"] = manager
        os.environ["ELIZA_BENCH_URL"] = manager.client.base_url
        os.environ["ELIZA_BENCH_TOKEN"] = manager.token

    shared_client = ElizaClient()
    shared_client.wait_until_ready(timeout=120)
    snapshot_path = _resolve_default_snapshot_path()

    def factory(_scenario: Scenario) -> AgentFn:
        return build_lifeops_bench_agent_fn(
            client=shared_client,
            world_snapshot_path=snapshot_path,
            now_iso=DEFAULT_NOW_ISO,
            model_name=model,
        )

    return factory


def _hermes_factory(model: str | None) -> AgentFactory:
    """One shared HermesClient; each task gets its own per-turn agent_fn."""
    ensure_benchmark_adapter_importable("hermes")
    from hermes_adapter.client import HermesClient
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    provider = (
        os.environ.get("BENCHMARK_MODEL_PROVIDER")
        or os.environ.get("ELIZA_PROVIDER")
        or "cerebras"
    ).strip().lower()
    model_name = model or os.environ.get("BENCHMARK_MODEL_NAME") or "gemma-4-31b"
    mode = (os.environ.get("HERMES_ADAPTER_MODE") or "in_process").strip() or "in_process"
    shared_client = HermesClient(provider=provider, model=model_name, mode=mode)
    shared_client.wait_until_ready(timeout=60)

    def factory(_scenario: Scenario) -> AgentFn:
        return build_lifeops_bench_agent_fn(client=shared_client, model_name=model_name)

    return factory


def _openclaw_factory(model: str | None) -> AgentFactory:
    """One shared OpenClawClient; each task gets its own per-turn agent_fn."""
    ensure_benchmark_adapter_importable("openclaw")
    from openclaw_adapter.client import OpenClawClient
    from openclaw_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    provider = (
        os.environ.get("BENCHMARK_MODEL_PROVIDER")
        or os.environ.get("ELIZA_PROVIDER")
        or "cerebras"
    ).strip().lower()
    model_name = model or os.environ.get("BENCHMARK_MODEL_NAME") or "gemma-4-31b"
    shared_client = OpenClawClient(
        provider=provider, model=model_name, direct_openai_compatible=True
    )
    shared_client.wait_until_ready(timeout=120)

    def factory(_scenario: Scenario) -> AgentFn:
        return build_lifeops_bench_agent_fn(
            client=shared_client,
            world_snapshot_path=_resolve_default_snapshot_path(),
            now_iso=DEFAULT_NOW_ISO,
            model_name=model_name,
        )

    return factory


_FACTORY_BUILDERS: dict[str, Callable[[str | None], AgentFactory]] = {
    "eliza": _eliza_factory,
    "hermes": _hermes_factory,
    "openclaw": _openclaw_factory,
    "perfect": lambda _model: _perfect_factory(),
    "wrong": lambda _model: _wrong_factory(),
}


def build_agent_factory(harness: str, *, model: str | None = None) -> AgentFactory:
    """Build the per-lane ``agent_factory`` for ``harness``.

    The returned factory shares one long-lived client across the tasks of a
    lane (the "one agent handling N" contract); ``perfect``/``wrong`` are the
    hermetic no-key oracles. Unknown harness ids raise immediately.
    """
    builder = _FACTORY_BUILDERS.get(harness)
    if builder is None:
        raise ValueError(
            f"unknown harness {harness!r}; expected one of "
            f"{sorted(_FACTORY_BUILDERS)}"
        )
    if harness == "eliza" and not os.environ.get("MULTITASK_ELIZA_USAGE_FIX"):
        raise SystemExit(
            "The eliza live lane needs the per-session usage-buffer fix in "
            "packages/lifeops-bench/src/server.ts (issue #13777 PR 1). Without "
            "it, MODEL_USED events from overlapping sessions land in one global "
            "buffer and per-task cost/token attribution is wrong. Set "
            "MULTITASK_ELIZA_USAGE_FIX=1 once that fix is in your tree to run "
            "the eliza lane anyway."
        )
    return builder(model)
