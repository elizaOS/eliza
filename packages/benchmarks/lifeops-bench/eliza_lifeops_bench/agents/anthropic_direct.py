"""Anthropic-direct adapter for LifeOpsBench."""

from __future__ import annotations

from ..clients.anthropic import AnthropicClient
from ._openai_compat import OpenAICompatAgent
from .planner_prompt import load_optimized_system_prompt


def build_anthropic_direct_agent(
    model: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    max_tokens: int | None = 4096,
) -> OpenAICompatAgent:
    """Build an Anthropic-backed agent callable for the bench runner."""
    system_prompt = load_optimized_system_prompt()

    def factory() -> AnthropicClient:
        return AnthropicClient(model=model, api_key=api_key)

    return OpenAICompatAgent(
        factory,
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )
