"""Cerebras-direct adapter for LifeOpsBench.

Wraps :class:`CerebrasClient` into an :class:`OpenAICompatAgent`.
Cerebras's chat-completions endpoint speaks native OpenAI tool-calling, so
this adapter is effectively just a constructor + the shared scaffolding —
all the heavy lifting (message translation, cost accounting) lives in
``_openai_compat``.
"""

from __future__ import annotations

import json
import os

from ..clients.cerebras import CerebrasClient
from ._openai_compat import LIFEOPS_TOOL_SYSTEM_PROMPT, OpenAICompatAgent


def _load_optimized_system_prompt() -> str:
    """Load the system prompt from LIFEOPS_PLANNER_PROMPT_FILE if set.

    Supports plain-text files and JSON artifacts produced by the MIPRO
    optimizer (which store the prompt under the ``prompt`` key).
    Falls back to the default bench system prompt when the env var is
    unset or the file cannot be read.
    """
    override_path = os.environ.get("LIFEOPS_PLANNER_PROMPT_FILE", "").strip()
    if not override_path or not os.path.exists(override_path):
        return LIFEOPS_TOOL_SYSTEM_PROMPT
    try:
        if override_path.endswith(".json"):
            with open(override_path, "r", encoding="utf-8") as fh:
                obj = json.load(fh)
            if isinstance(obj, dict) and isinstance(obj.get("prompt"), str):
                return obj["prompt"]
        else:
            text = open(override_path, "r", encoding="utf-8").read().strip()
            if text:
                return text
    except OSError:
        pass
    return LIFEOPS_TOOL_SYSTEM_PROMPT


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
    system_prompt = _load_optimized_system_prompt()

    def factory() -> CerebrasClient:
        return CerebrasClient(model=model, base_url=base_url, api_key=api_key)

    return OpenAICompatAgent(
        factory,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )
