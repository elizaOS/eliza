"""Reference + adapter agents for LifeOpsBench.

PerfectAgent / WrongAgent are the conformance oracles (Wave 2F).
``build_eliza_agent`` is the production-path adapter (Wave 2C); it
delegates to :func:`eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..types import MessageTurn
from ._openai_compat import OpenAICompatAgent
from .cerebras_direct import build_cerebras_direct_agent
from .hermes import build_hermes_agent
from .openclaw import OpenClawAgent, build_openclaw_agent
from .perfect import PerfectAgent
from .wrong import WrongAgent, WrongMode

DEFAULT_SNAPSHOT_FILENAME = "medium_seed_2026.json"
DEFAULT_NOW_ISO = "2026-05-10T12:00:00Z"


def _resolve_default_snapshot_path() -> str:
    """Locate the canonical medium-seed snapshot relative to this package.

    Layout: ``packages/benchmarks/lifeops-bench/data/snapshots/medium_seed_2026.json``.
    Allow operators to override via ``LIFEOPS_BENCH_SNAPSHOT_PATH``.
    """
    override = os.environ.get("LIFEOPS_BENCH_SNAPSHOT_PATH", "").strip()
    if override:
        return override
    here = Path(__file__).resolve()
    pkg_root = here.parents[2]  # packages/benchmarks/lifeops-bench
    return str(pkg_root / "data" / "snapshots" / DEFAULT_SNAPSHOT_FILENAME)


def build_eliza_agent(
    *,
    world_snapshot_path: str | None = None,
    now_iso: str = DEFAULT_NOW_ISO,
    model_name: str | None = None,
) -> Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]:
    """Build the elizaOS-runtime-backed agent for LifeOpsBench.

    Wraps :func:`eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`
    with bench-friendly defaults: the canonical medium-seed snapshot from
    ``data/snapshots/`` and the project-standard ``now_iso``.
    """
    try:
        from eliza_adapter.lifeops_bench import build_lifeops_bench_agent_fn
    except ImportError as exc:  # pragma: no cover — import-only branch
        raise SystemExit(
            "build_eliza_agent requires the eliza-adapter package "
            "(packages/benchmarks/eliza-adapter). Install it in the active env."
        ) from exc

    snapshot_path = world_snapshot_path or _resolve_default_snapshot_path()
    return build_lifeops_bench_agent_fn(
        world_snapshot_path=snapshot_path,
        now_iso=now_iso,
        model_name=model_name,
    )


__all__ = [
    "OpenAICompatAgent",
    "OpenClawAgent",
    "PerfectAgent",
    "WrongAgent",
    "WrongMode",
    "build_cerebras_direct_agent",
    "build_eliza_agent",
    "build_hermes_agent",
    "build_openclaw_agent",
]
