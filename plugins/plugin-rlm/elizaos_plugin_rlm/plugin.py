"""
RLM (Recursive Language Model) plugin for elizaOS.

This plugin mirrors the role of other engine/model adapters (e.g., LocalAI) but
is fully self-contained in Python. It exposes an async provider that delegates
text generation to an optional RLM backend. When RLM is not installed, it
returns a safe stub response.

SOURCE OF TRUTH:
- RLM client layer: packages/python/elizaos/providers/rlm_client.py
- RLM provider layer: packages/python/elizaos/providers/rlm_provider.py

This plugin adapts those canonical implementations to the plugin system without
redesigning the logic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union
import asyncio
import logging
import os

from elizaos.types.plugin import Plugin
from elizaos.types.components import Provider, ProviderResult
from elizaos.logger import create_logger

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.memory import Memory
    from elizaos.types.state import State

logger = create_logger(namespace="plugin-rlm")


# ============================================================================
# RLM CLIENT LAYER (ported from elizaos/providers/rlm_client.py)
# ============================================================================
# Design principles:
# - Eliza owns conversation state and message construction
# - RLM only receives messages and returns a response
# - No global state, no system prompt injection
# - Safe stub behavior when RLM is not installed
# ============================================================================

# Optional dependency: AgentRLM
try:
    from rlm import RLM  # type: ignore
except Exception as e:
    RLM = None
    logger.debug("AgentRLM not available: %s", e)


class RLMClient:
    """
    Thin adapter exposing `infer(messages, opts)`.

    One RLM instance per client.
    Ported from: elizaos/providers/rlm_client.py
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self._rlm = None

        if RLM is not None:
            try:
                self._rlm = RLM(
                    backend=self.config.get(
                        "backend", os.getenv("ELIZA_RLM_BACKEND", "gemini")
                    ),
                    backend_kwargs=self.config.get("backend_kwargs", {}),
                    environment=self.config.get(
                        "environment", os.getenv("ELIZA_RLM_ENV", "local")
                    ),
                    max_iterations=int(
                        self.config.get(
                            "max_iterations",
                            os.getenv("ELIZA_RLM_MAX_ITERATIONS", "4"),
                        )
                    ),
                    max_depth=int(
                        self.config.get(
                            "max_depth",
                            os.getenv("ELIZA_RLM_MAX_DEPTH", "1"),
                        )
                    ),
                    verbose=str(
                        self.config.get(
                            "verbose",
                            os.getenv("ELIZA_RLM_VERBOSE", "false"),
                        )
                    ).lower()
                    in ("1", "true", "yes"),
                )
            except Exception as e:
                logger.exception("Failed to initialize RLM: %s", e)
                self._rlm = None

    async def _completion(self, messages: List[Dict[str, str]]):
        """
        Run synchronous RLM completion in a thread to avoid blocking.
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: self._rlm.completion(messages)
        )

    async def infer(
        self,
        messages: Union[str, List[Dict[str, str]]],
        opts: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Perform inference using RLM.

        Parameters:
        - messages: list of {"role","content"} dicts OR a single prompt string
        - opts: optional generation parameters (currently unused by RLM)

        Returns:
        - dict with at least {"text": str}
        """

        if self._rlm is None:
            return {
                "text": "[RLM STUB] RLM backend not available",
                "metadata": {"stub": True},
            }

        # Normalize input
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]

        try:
            result = await self._completion(messages)
        except Exception as e:
            logger.exception("RLM completion failed: %s", e)
            return {
                "text": "[RLM ERROR] Failed to generate response",
                "metadata": {"error": str(e)},
            }

        # Normalize output
        if hasattr(result, "response"):
            text = result.response or ""
        else:
            text = str(result)

        return {
            "text": text.strip(),
            "metadata": {"stub": False},
        }


# ============================================================================
# RLM PROVIDER LAYER (ported from elizaos/providers/rlm_provider.py)
# ============================================================================
# Delegates text generation to RLMClient.
# Eliza remains responsible for memory, planning, tools, and autonomy.
# ============================================================================

# Shared client instance (lazily initialized)
_rlm_client: Optional[RLMClient] = None


def _get_or_create_client(runtime: "IAgentRuntime") -> RLMClient:
    """Get or create the shared RLM client instance."""
    global _rlm_client
    if _rlm_client is None:
        config = getattr(runtime, "rlm_config", {})
        _rlm_client = RLMClient(config)
    return _rlm_client


async def rlm_provider_get(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State" | None = None,
) -> ProviderResult:
    """
    Informational provider call (used for listing providers).
    Ported from: RLMProvider.get()
    """
    return ProviderResult(
        text="RLM inference backend (Recursive Language Models)",
        values={},
        data={},
    )


async def handle_text_generation(
    runtime: "IAgentRuntime",
    params: Dict[str, Any],
) -> str:
    """
    High-level model handler for TEXT_SMALL, TEXT_LARGE, TEXT_REASONING_*, TEXT_COMPLETION.
    Ported from: RLMProvider.generate_text()

    Expected params (GenerateTextParams):
      - prompt: string (required)
      - system: string (optional system prompt)
      - messages: list of {"role","content"} dicts (optional, overrides prompt)
      - temperature, maxTokens, topP, stopSequences, user, stream: optional controls

    Returns:
      - string: generated text
    """
    client = _get_or_create_client(runtime)

    # Prefer structured messages if available, else use prompt
    prompt_or_messages = params.get("messages") or params.get("prompt", "")

    # NOTE:
    # RLM currently ignores most generation controls.
    # These are forwarded for future compatibility.
    client_opts = {
        "model": params.get("model"),
        "max_tokens": params.get("maxTokens"),
        "temperature": params.get("temperature"),
        "top_p": params.get("topP"),
        "stop_sequences": params.get("stopSequences"),
        "user": params.get("user"),
        "stream": params.get("stream", False),
    }

    # Drop None values
    client_opts = {k: v for k, v in client_opts.items() if v is not None}

    result = await client.infer(prompt_or_messages, client_opts)

    # Normalize result to string (v2 model API expects string for text generation models)
    if isinstance(result, dict):
        return result.get("text") or str(result.get("response") or result.get("result") or "")
    return str(result)


rlm_provider = Provider(
    name="RLM",
    description="RLM inference backend (Recursive Language Models)",
    dynamic=True,
    get=rlm_provider_get,
)


# ============================================================================
# Plugin definition (Eliza v2 model layer)
# ============================================================================

async def plugin_init(config: Dict[str, Any], runtime: "IAgentRuntime") -> None:
    """
    Initialize plugin: store RLM config on runtime.
    Adapted from: register_rlm_provider()
    """
    logger.info("Initializing RLM plugin")

    # Store config on runtime for client instantiation
    runtime.rlm_config = config  # type: ignore


# Plugin models dict: maps ModelType -> handler (registered by plugin system)
from elizaos.types.model import ModelType

plugin_models = {
    ModelType.TEXT_SMALL.value: handle_text_generation,
    ModelType.TEXT_LARGE.value: handle_text_generation,
    ModelType.TEXT_REASONING_SMALL.value: handle_text_generation,
    ModelType.TEXT_REASONING_LARGE.value: handle_text_generation,
    ModelType.TEXT_COMPLETION.value: handle_text_generation,
}


plugin = Plugin(
    name="plugin-rlm",
    description="RLM (Recursive Language Model) adapter for elizaOS",
    init=plugin_init,
    config={
        "backend": os.getenv("ELIZA_RLM_BACKEND", "gemini"),
        "backend_kwargs": {},
        "environment": os.getenv("ELIZA_RLM_ENV", "local"),
        "max_iterations": os.getenv("ELIZA_RLM_MAX_ITERATIONS", "4"),
        "max_depth": os.getenv("ELIZA_RLM_MAX_DEPTH", "1"),
        "verbose": os.getenv("ELIZA_RLM_VERBOSE", "false"),
    },
    actions=[],
    providers=[rlm_provider],
    services=[],
    models=plugin_models,  # Declarative model registration (v2 API)
    tests=[],
)
