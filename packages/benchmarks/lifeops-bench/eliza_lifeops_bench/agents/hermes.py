"""Hermes adapter for LifeOpsBench.

Wraps :class:`HermesClient` (Wave 1E) into an :class:`OpenAICompatAgent`
that the runner can drive. The client itself owns the Hermes XML
``<tool_call>`` / ``<tool_response>`` translation and the system-prompt
template — this adapter just funnels the runner's ``MessageTurn`` history
into the client and unpacks the response back into a ``MessageTurn`` with
cost/latency telemetry attached.
"""

from __future__ import annotations

from ..clients.hermes import HermesClient
from ._openai_compat import OpenAICompatAgent


def build_hermes_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = None,
) -> OpenAICompatAgent:
    """Build a Hermes-template agent callable for the bench runner.

    Returns an :class:`OpenAICompatAgent` whose ``__call__(history, tools)``
    matches the runner's ``AgentFn`` signature. Cost is tracked on the
    instance via ``total_cost_usd``; per-turn cost is also attached to each
    returned ``MessageTurn`` so the runner's existing ``getattr`` accounting
    works without any runner changes.

    The :class:`HermesClient` is constructed lazily on the first
    completion. Construction reads ``HERMES_BASE_URL`` / ``HERMES_API_KEY``
    / ``HERMES_MODEL`` from the environment unless explicit args override.
    """

    def factory() -> HermesClient:
        return HermesClient(model=model, base_url=base_url, api_key=api_key)

    return OpenAICompatAgent(
        factory,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_tokens=max_tokens,
    )
