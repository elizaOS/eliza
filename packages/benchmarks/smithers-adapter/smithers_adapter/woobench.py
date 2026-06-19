"""WooBench agent_fn backed by the Smithers harness.

WooBench's turn logic (payment-state machine, system hints, tool gating) is
harness-agnostic — it only needs a client exposing
``send_message`` / ``reset`` / ``wait_until_ready``, which :class:`SmithersClient`
provides. Rather than duplicate ~350 lines, we delegate to the hermes WooBench
builder with a SmithersClient injected. (``hermes-adapter`` is always on the
benchmark PYTHONPATH alongside the other adapters.)
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from smithers_adapter.client import SmithersClient


def build_smithers_woobench_agent_fn(
    client: SmithersClient | None = None,
    *,
    model_name: str | None = None,
) -> Callable[[list[dict[str, str]]], Awaitable[dict[str, Any]]]:
    from hermes_adapter.woobench import build_hermes_woobench_agent_fn

    bridge = client or SmithersClient(model=model_name or "gpt-oss-120b")
    # The hermes builder is generic over any client with the MessageResponse
    # contract; SmithersClient satisfies it.
    return build_hermes_woobench_agent_fn(client=bridge, model_name=model_name)


__all__ = ["build_smithers_woobench_agent_fn"]
