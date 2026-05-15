"""Harness routing for GAIA benchmark agents.

GAIA uses one benchmark runner, but the matrix can label execution as
``eliza``, ``hermes``, or ``openclaw``. The concrete transport is the
``eliza_adapter`` client: native Eliza goes to the TypeScript benchmark
server, while Hermes/OpenClaw are delegated by that client when the harness
environment variables below are set.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_gaia.types import GAIAConfig

_HARNESS_ALIASES = {
    "eliza": "eliza",
    "elizaos": "eliza",
    "eliza-os": "eliza",
    "ts": "eliza",
    "typescript": "eliza",
    "hermes": "hermes",
    "hermes-agent": "hermes",
    "openclaw": "openclaw",
    "open-claw": "openclaw",
}

_BACKENDS = {
    "eliza": "eliza_ts_bridge",
    "hermes": "hermes_adapter_via_eliza_client",
    "openclaw": "openclaw_adapter_via_eliza_client",
}


def _ensure_adapter_paths() -> None:
    root = Path(__file__).resolve().parents[2]
    for name in ("eliza-adapter", "hermes-adapter", "openclaw-adapter"):
        candidate = root / name
        if candidate.exists():
            path = str(candidate)
            if path not in sys.path:
                sys.path.insert(0, path)


_ensure_adapter_paths()


@dataclass(frozen=True)
class HarnessRoute:
    """Resolved GAIA execution route."""

    harness: str
    backend: str


def normalize_harness_label(value: str | None) -> str | None:
    """Normalize a user/provider label to a canonical harness label."""
    if value is None:
        return None
    normalized = value.strip().lower().replace("_", "-")
    if not normalized:
        return None
    return _HARNESS_ALIASES.get(normalized)


def resolve_harness(
    config: "GAIAConfig | None" = None,
    *,
    explicit: str | None = None,
) -> HarnessRoute:
    """Resolve GAIA's canonical harness route.

    Precedence is explicit argument, ``config.harness``, harness environment,
    then ``eliza``. Unknown labels fall back to ``eliza`` so legacy
    orchestrator provider labels such as ``claude-code`` do not accidentally
    create new GAIA harnesses.
    """
    candidates = [
        explicit,
        getattr(config, "harness", None) if config is not None else None,
        os.environ.get("ELIZA_BENCH_HARNESS"),
        os.environ.get("BENCHMARK_HARNESS"),
        os.environ.get("BENCHMARK_AGENT"),
    ]
    for candidate in candidates:
        harness = normalize_harness_label(candidate)
        if harness:
            return HarnessRoute(harness=harness, backend=_BACKENDS[harness])
    return HarnessRoute(harness="eliza", backend=_BACKENDS["eliza"])


def harness_env_updates(route: HarnessRoute) -> dict[str, str]:
    """Environment values consumed by ``eliza_adapter.client`` delegates."""
    return {
        "ELIZA_BENCH_HARNESS": route.harness,
        "BENCHMARK_HARNESS": route.harness,
        "BENCHMARK_AGENT": route.harness,
    }


def create_gaia_agent(
    config: "GAIAConfig",
    *,
    route: HarnessRoute | None = None,
):
    """Create the GAIA agent for a resolved harness route."""
    resolved = route or resolve_harness(config)
    os.environ.update(harness_env_updates(resolved))

    from eliza_adapter.gaia import ElizaGAIAAgent

    return ElizaGAIAAgent(config)
