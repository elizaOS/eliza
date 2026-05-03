"""Vending-Bench LLM provider backed by the eliza TS benchmark server.

Implements the duck-typed ``LLMProvider`` protocol expected by
``elizaos_vending_bench.agent.VendingAgent``: a single ``generate``
coroutine returning ``(response_text, tokens_used)``. Each call is
forwarded to the eliza TS bridge via ``ElizaClient.send_message`` so
no Python ``AgentRuntime`` is needed.
"""

from __future__ import annotations

import logging
from typing import Optional

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


class ElizaVendingProvider:
    """LLMProvider implementation that routes through the eliza TS bridge.

    Drop-in replacement for ``OpenAIProvider`` / ``AnthropicProvider`` etc.
    when running with ``--provider eliza``. The bridge owns the underlying
    model selection through the runtime config, so no per-call model
    parameter is needed here.
    """

    def __init__(
        self,
        client: Optional[ElizaClient] = None,
        model: str = "eliza-ts-bridge",
    ) -> None:
        self._client = client or ElizaClient()
        self.model = model
        self._initialized = False

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        await self._ensure_initialized()

        prompt = f"{system_prompt}\n\n{user_prompt}" if system_prompt else user_prompt

        try:
            response = self._client.send_message(
                text=prompt,
                context={
                    "benchmark": "vending-bench",
                    "system_prompt": system_prompt,
                    "temperature": temperature,
                },
            )
        except Exception as exc:
            logger.error("[eliza-vending] send_message failed: %s", exc)
            raise

        return (response.text or "", 0)

    async def reset(self, run_id: str) -> None:
        """Reset the bridge session at the start of a new simulation run."""
        try:
            self._client.reset(task_id=run_id, benchmark="vending-bench")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)
