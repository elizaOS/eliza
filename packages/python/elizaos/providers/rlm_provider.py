"""
RLMProvider - a thin provider adapter for Eliza runtime.

Delegates text generation to RLMClient.
Eliza remains responsible for memory, planning, tools, and autonomy.
"""

from typing import Any, Dict, Optional
import logging

from .rlm_client import RLMClient

log = logging.getLogger(__name__)


class RLMProvider:
    name = "RLM"
    description = "RLM inference backend (Recursive Language Models)"
    dynamic = True

    def __init__(
        self,
        client: Optional[RLMClient] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        self.config = config or {}
        self.client = client or RLMClient(self.config)

    async def get(
        self,
        runtime: Any,
        message: Dict[str, Any],
        state: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Informational provider call (used for listing providers).
        """
        return {"text": self.description, "values": {}, "data": {}}

    async def generate_text(
        self,
        runtime: Any,
        params: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        High-level model call used by the runtime.

        Expected params:
          - messages: list of {"role","content"} dicts (preferred)
          - prompt: string (fallback)

        Other generation controls are accepted but currently unused by RLM.
        """

        # Prefer structured messages if available
        prompt_or_messages = params.get("messages") or params.get("prompt", "")

        # NOTE:
        # RLM currently ignores most generation controls.
        # These are forwarded for future compatibility.
        client_opts = {
            "model": params.get("model") or self.config.get("model"),
            "max_tokens": params.get("maxTokens"),
            "temperature": params.get("temperature"),
            "top_p": params.get("topP"),
            "stop_sequences": params.get("stopSequences"),
            "user": params.get("user"),
            "stream": params.get("stream", False),
        }

        # Drop None values
        client_opts = {k: v for k, v in client_opts.items() if v is not None}

        result = await self.client.infer(prompt_or_messages, client_opts)

        if not isinstance(result, dict):
            return {"text": str(result)}

        if "text" not in result:
            result["text"] = str(result.get("response") or result.get("result") or "")

        return result


def register_rlm_provider(
    runtime: Any,
    config: Optional[Dict[str, Any]] = None,
) -> RLMProvider:
    """
    Register RLMProvider with a runtime instance.
    """

    provider = RLMProvider(config=config)

    if hasattr(runtime, "register_provider") and callable(runtime.register_provider):
        runtime.register_provider(provider)
        log.debug("RLMProvider registered via runtime.register_provider")
        return provider

    if hasattr(runtime, "providers") and isinstance(runtime.providers, list):
        runtime.providers.append(provider)
        log.debug("RLMProvider appended to runtime.providers")
        return provider

    raise RuntimeError(
        "Unable to register RLMProvider: runtime has no provider registration mechanism"
    )
