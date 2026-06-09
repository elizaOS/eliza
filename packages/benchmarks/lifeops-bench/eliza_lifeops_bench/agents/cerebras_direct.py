"""Cerebras-direct adapter for LifeOpsBench.

Wraps :class:`CerebrasClient` into an :class:`OpenAICompatAgent`.
Cerebras's chat-completions endpoint speaks native OpenAI tool-calling, so
this adapter is effectively just a constructor + the shared scaffolding —
all the heavy lifting (message translation, cost accounting) lives in
``_openai_compat``.
"""

from __future__ import annotations

from ..clients.cerebras import CerebrasClient
from ._openai_compat import OpenAICompatAgent
from .planner_prompt import load_optimized_system_prompt


def build_cerebras_direct_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = 4096,
) -> OpenAICompatAgent:
    """Build a Cerebras-direct agent callable for the bench runner.

    Returns an :class:`OpenAICompatAgent` whose ``__call__(history, tools)``
    matches the runner's ``AgentFn`` signature. Cumulative spend is
    available via ``total_cost_usd``; per-turn telemetry is attached to
    each returned ``MessageTurn``.

    The :class:`CerebrasClient` is constructed lazily on the first
    completion. Construction reads ``CEREBRAS_API_KEY`` / ``CEREBRAS_MODEL``
    / ``CEREBRAS_BASE_URL`` from the environment unless explicit args
    override.

    When ``LIFEOPS_PLANNER_PROMPT_FILE`` is set, the system prompt is loaded
    from that path (plain text or JSON artifact with a ``prompt`` key) instead
    of the default bench prompt.
    """
    system_prompt = load_optimized_system_prompt()

    def factory() -> CerebrasClient:
        return CerebrasClient(model=model, base_url=base_url, api_key=api_key)

    return OpenAICompatAgent(
        factory,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )
