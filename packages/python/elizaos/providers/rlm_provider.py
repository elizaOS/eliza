"""
RLMProvider - a thin provider adapter for Eliza runtime.

This provider delegates model work to RLMClient. It exposes:
- get(runtime, message, state): provider-style informational call
- generate_text(runtime, params): high-level generation hook returning dict with 'text' key

Also supplies a small helper register_rlm_provider(runtime, config=None) to register with the runtime.
"""

from typing import Any, Dict, Optional
import logging

from .rlm_client import RLMClient

log = logging.getLogger(__name__)


class RLMProvider:
    name = "RLM"
    description = "RLM inference backend (Recursive Language Models)"
    dynamic = True

    def __init__(self, client: Optional[RLMClient] = None, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.client = client or RLMClient(self.config)

    async def get(self, runtime: Any, message: Dict[str, Any], state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Minimal provider.get implementation: returns a short description.
        Runtime may call .get(provider) to list available providers.
        """
        return {"text": self.description, "values": {}, "data": {}}

    async def generate_text(self, runtime: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        High-level model call used by runtime (maps Eliza params to RLMClient).
        Expected params keys:
          - prompt (str) OR messages (list of {"role","content"})
          - history (optional list)
          - other model controls (temperature, maxTokens, topP, stopSequences) — forwarded in opts
        Returns dict with at least 'text' (string).
        """
        # Prefer structured messages if provided
        prompt_or_messages = params.get("messages") or params.get("prompt", "")

        # Build client options mapping (keep names simple)
        client_opts = {
            "model": params.get("model") or self.config.get("model"),
            "max_tokens": params.get("maxTokens"),
            "temperature": params.get("temperature"),
            "top_p": params.get("topP"),
            "stop_sequences": params.get("stopSequences"),
            "user": params.get("user"),
            "stream": params.get("stream", False),
            "history": params.get("history"),
        }

        # Remove None values to keep opts tidy
        client_opts = {k: v for k, v in client_opts.items() if v is not None}

        # Delegate to the client adapter
        result = await self.client.infer(prompt_or_messages, client_opts)

        # Ensure result has at least a text key
        if not isinstance(result, dict):
            return {"text": str(result)}
        if "text" not in result:
            # If result uses 'response' key like some RLM clients, map it
            if "response" in result:
                result["text"] = result.get("response") or ""
            else:
                result["text"] = str(result.get("result") or "")

        return result


def register_rlm_provider(runtime: Any, config: Optional[Dict[str, Any]] = None) -> RLMProvider:
    """
    Convenience helper to register an RLMProvider instance with the runtime.

    Expected runtime API:
      - runtime.register_provider(provider_instance)
      OR
      - runtime.providers (list) and runtime exposes a method to add providers.

    This helper will try common patterns but will not mutate unpredictable runtime APIs.
    """
    provider = RLMProvider(config=config and config.get("provider_config"))

    # Try well-known registration method
    if hasattr(runtime, "register_provider") and callable(getattr(runtime, "register_provider")):
        runtime.register_provider(provider)  # type: ignore
        log.debug("RLMProvider registered via runtime.register_provider")
        return provider

    # Try appending to runtime.providers list if present
    if hasattr(runtime, "providers") and isinstance(getattr(runtime, "providers"), list):
        runtime.providers.append(provider)  # type: ignore
        log.debug("RLMProvider appended to runtime.providers list")
        return provider

    # Unsupported runtime shape; raise informative error
    raise RuntimeError("Unable to register RLMProvider: runtime has no register_provider method or providers list")