"""Hermes-specific helpers for the LOCA OpenAI-compatible harness proxy."""

from __future__ import annotations

import os
from typing import Any, Mapping


def build_hermes_loca_client(*, provider: str, model: str, timeout_s: float) -> Any:
    """Return a Hermes client configured for LOCA's long-context proxy path."""

    from hermes_adapter.client import HermesClient

    return HermesClient(provider=provider, model=model, timeout_s=timeout_s)


def hermes_loca_metadata(response: Any) -> dict[str, Any]:
    """Metadata persisted in LOCA raw responses for fair cross-agent audits."""

    params = getattr(response, "params", {})
    usage = params.get("usage") if isinstance(params, Mapping) else None
    tool_calls = params.get("tool_calls") if isinstance(params, Mapping) else None
    return {
        "benchmark_harness": "hermes",
        "adapter": "hermes-adapter",
        "agent_family": "hermes",
        "native_tool_calls": isinstance(tool_calls, list),
        "tool_call_count": len(tool_calls) if isinstance(tool_calls, list) else 0,
        "provider": (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower(),
        "model": (
            os.environ.get("BENCHMARK_MODEL_NAME")
            or os.environ.get("MODEL_NAME")
            or os.environ.get("CEREBRAS_MODEL")
            or "gpt-oss-120b"
        ).strip(),
        "usage": dict(usage) if isinstance(usage, Mapping) else {},
    }


__all__ = ["build_hermes_loca_client", "hermes_loca_metadata"]
