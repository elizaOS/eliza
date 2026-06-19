"""Smithers adapter for LifeOpsBench.

The LifeOps agent_fn (``hermes_adapter.lifeops_bench.build_lifeops_bench_agent_fn``)
is harness-agnostic — it owns the tool-call translation and only needs a client
with the ``MessageResponse`` contract. We inject a :class:`SmithersClient` and
reuse it, wrapped in the same telemetry-tracking callable as the hermes path.
"""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable

from ..types import MessageTurn
from .adapter_paths import ensure_benchmark_adapter_importable
from .hermes import HermesLifeOpsAgent


def build_smithers_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = 4096,
) -> Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]:
    """Build a Smithers LifeOps agent callable for the bench runner."""
    ensure_benchmark_adapter_importable("smithers")
    ensure_benchmark_adapter_importable("hermes")
    from smithers_adapter.client import SmithersClient
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    provider = (
        os.environ.get("BENCHMARK_MODEL_PROVIDER") or os.environ.get("ELIZA_PROVIDER") or "cerebras"
    ).strip().lower()
    client_kwargs: dict[str, Any] = {
        "provider": provider,
        "temperature": temperature,
        "reasoning_effort": reasoning_effort,
        "max_tokens": max_tokens,
    }
    if model:
        client_kwargs["model"] = model
    if base_url:
        client_kwargs["base_url"] = base_url
    if api_key:
        client_kwargs["api_key"] = api_key
    client = SmithersClient(**client_kwargs)

    system_prompt = (
        "You are running LifeOpsBench. Use the supplied tools exactly "
        "when they are needed, and keep responses concise. "
        "For BLOCK actions, use bundle_id (e.g., 'com.apple.Safari') not app_name."
    )
    inner = build_lifeops_bench_agent_fn(
        client=client,
        model_name=model,
        system_prompt=system_prompt,
    )
    return HermesLifeOpsAgent(inner)
