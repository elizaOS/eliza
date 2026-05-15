"""GAIA-local harness routing helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

from elizaos_gaia.types import GAIAConfig, GAIAQuestion, GAIAResult

HARNESS_ALIASES: dict[str, str] = {
    "eliza": "eliza",
    "elizaos": "eliza",
    "hermes": "hermes",
    "hermes-agent": "hermes",
    "openclaw": "openclaw",
    "open-claw": "openclaw",
    "open_claw": "openclaw",
}

HARNESS_BACKENDS: dict[str, str] = {
    "eliza": "eliza_ts_bridge",
    "hermes": "hermes_adapter_via_eliza_client",
    "openclaw": "openclaw_adapter_via_eliza_client",
}


class GAIAAgent(Protocol):
    """Minimal protocol implemented by GAIA adapter agents."""

    model_config: object

    @property
    def model_identifier(self) -> str: ...

    async def solve(self, question: GAIAQuestion) -> GAIAResult: ...

    async def close(self) -> None: ...


@dataclass(frozen=True)
class HarnessRoute:
    """Resolved execution harness for one GAIA run."""

    harness: str
    backend: str


def normalize_harness_label(value: str | None) -> str | None:
    """Normalize known harness aliases into canonical labels."""
    if not value:
        return None
    key = value.strip().lower()
    if not key:
        return None
    return HARNESS_ALIASES.get(key)


def current_harness() -> str | None:
    """Resolve harness from environment variables used by benchmark adapters."""
    for env_name in ("ELIZA_BENCH_HARNESS", "BENCHMARK_HARNESS", "BENCHMARK_AGENT"):
        harness = normalize_harness_label(os.environ.get(env_name))
        if harness:
            return harness
    return None


def resolve_harness(config: GAIAConfig | None = None, explicit: str | None = None) -> HarnessRoute:
    """Resolve the canonical harness for a GAIA run.

    GAIA still uses the eliza-adapter GAIA agent class as the benchmark-facing
    shim. For Hermes/OpenClaw, ``ElizaClient`` delegates to their native client
    implementations based on the benchmark harness environment. The returned
    backend string makes that routing explicit in metadata and artifacts.
    """
    configured = explicit
    if configured is None and config is not None:
        configured = config.harness or config.provider
    harness = normalize_harness_label(configured) or current_harness() or "eliza"
    return HarnessRoute(
        harness=harness,
        backend=HARNESS_BACKENDS.get(harness, f"{harness}_adapter"),
    )


def harness_env_updates(route: HarnessRoute) -> dict[str, str]:
    """Environment variables needed by eliza-adapter delegate routing."""
    return {
        "BENCHMARK_HARNESS": route.harness,
        "ELIZA_BENCH_HARNESS": route.harness,
        "BENCHMARK_AGENT": route.harness,
    }


def create_gaia_agent(config: GAIAConfig, *, route: HarnessRoute | None = None) -> GAIAAgent:
    """Create the GAIA adapter agent for the resolved harness route."""
    resolved = route or resolve_harness(config)
    for key, value in harness_env_updates(resolved).items():
        os.environ[key] = value

    from eliza_adapter.client import ElizaClient
    from eliza_adapter.gaia import ElizaGAIAAgent

    return ElizaGAIAAgent(config, client=ElizaClient())
