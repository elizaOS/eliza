"""Direct OpenAI-compatible agent path for Hermes-template model endpoints.

Unlike the source-harness ``hermes`` adapter, this path talks to the endpoint
named by ``HERMES_BASE_URL`` without starting or waiting for another process.
It supports real local Ollama/vLLM/llama.cpp runs as well as hosted gateways.
"""

from __future__ import annotations

from ..clients.hermes import HermesClient
from ._openai_compat import LIFEOPS_TOOL_SYSTEM_PROMPT, OpenAICompatAgent


def build_hermes_direct_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = 4096,
) -> OpenAICompatAgent:
    """Build an agent that calls one configured OpenAI-compatible endpoint."""

    def factory() -> HermesClient:
        return HermesClient(model=model, base_url=base_url, api_key=api_key)

    return OpenAICompatAgent(
        factory,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_tokens=max_tokens,
        system_prompt=LIFEOPS_TOOL_SYSTEM_PROMPT,
    )


__all__ = ["build_hermes_direct_agent"]
