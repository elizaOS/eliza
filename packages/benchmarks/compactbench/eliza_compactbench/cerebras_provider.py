"""Cerebras provider for CompactBench's question-answering judge.

Cerebras's public inference API is OpenAI-compatible
(``https://api.cerebras.ai/v1``), so this provider is a thin wrapper
around the ``openai`` Python SDK with the ``base_url`` repointed.

CompactBench v0.1.0 does **not** ship an ``OpenAIProvider`` — only
``mock``, ``groq``, ``google-ai-studio``, and ``ollama`` — so this is a
fresh ``Provider`` subclass rather than a thin override.

Registration
------------
The provider registry (``compactbench.providers._REGISTRY``) is a
module-level dict of ``{key: ProviderClass}``. There is no public
"register" API in v0.1.0, but the dict can be mutated at import time so
the ``compactbench run --provider cerebras`` CLI flag resolves correctly.

If a future CompactBench release locks the registry down,
:func:`register_cerebras_provider` will return ``False`` and callers
should fall back to ``--provider groq``.
"""

from __future__ import annotations

import os
from typing import Any, ClassVar

from compactbench.providers._retry import retry_with_backoff
from compactbench.providers.base import (
    CompletionRequest,
    CompletionResponse,
    Provider,
)
from compactbench.providers.errors import ProviderError, ProviderResponseError

CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b"


class CerebrasProvider(Provider):
    """OpenAI-compatible provider pointed at Cerebras inference."""

    key: ClassVar[str] = "cerebras"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = CEREBRAS_BASE_URL,
        max_retries: int = 3,
        base_backoff_seconds: float = 2.0,
    ) -> None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise ProviderError(
                "openai SDK is not installed. Install with: pip install openai"
            ) from exc

        resolved_key = (
            api_key
            or os.environ.get("CEREBRAS_API_KEY")
            or os.environ.get("COMPACTBENCH_CEREBRAS_API_KEY")
        )
        if not resolved_key:
            raise ProviderError(
                "Cerebras API key required. Set CEREBRAS_API_KEY or pass api_key=."
            )

        self._client: Any = AsyncOpenAI(api_key=resolved_key, base_url=base_url)
        self._max_retries = max_retries
        self._base_backoff_seconds = base_backoff_seconds

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        from openai import (
            APIConnectionError,
            APITimeoutError,
            InternalServerError,
            RateLimitError,
        )

        def _is_retryable(exc: Exception) -> bool:
            return isinstance(
                exc,
                (RateLimitError, APITimeoutError, APIConnectionError, InternalServerError),
            )

        # compactbench v0.1.0's CompletionRequest is {model, prompt, system,
        # max_tokens, temperature, response_format}. No cached_prefix.
        # Use getattr so a future version that adds it Just Works.
        cached_prefix = getattr(request, "cached_prefix", "") or ""
        user_content = cached_prefix + request.prompt
        messages: list[dict[str, str]] = []
        if request.system:
            messages.append({"role": "system", "content": request.system})
        messages.append({"role": "user", "content": user_content})

        kwargs: dict[str, Any] = {
            "model": request.model,
            "messages": messages,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            # gpt-oss-* are reasoning models; without "low" they exhaust the
            # token budget on internal reasoning. See bridge/drift fixes.
            "reasoning_effort": os.environ.get(
                "CEREBRAS_REASONING_EFFORT", "low"
            ),
        }
        if request.response_format:
            kwargs["response_format"] = request.response_format

        async def _call() -> Any:
            return await self._client.chat.completions.create(**kwargs)

        response = await retry_with_backoff(
            _call,
            is_retryable=_is_retryable,
            max_retries=self._max_retries,
            base_delay=self._base_backoff_seconds,
        )

        choices: list[Any] = getattr(response, "choices", None) or []
        if not choices:
            raise ProviderResponseError("Cerebras returned no choices in response")
        choice: Any = choices[0]
        message: Any = getattr(choice, "message", None)
        # gpt-oss-120b on Cerebras returns the visible answer in
        # message.content for most calls, but occasionally routes the
        # entire response through message.reasoning with no separate
        # content. Mirror the TS bridge's content-or-reasoning fallback so
        # we don't lose the response. The OpenAI SDK exposes vendor-only
        # fields on message.model_extra (Pydantic v2) or as plain
        # attributes when the vendor responds with snake-case keys.
        content_raw: Any = getattr(message, "content", None)
        text = content_raw if isinstance(content_raw, str) and content_raw else ""
        if not text:
            reasoning_raw: Any = getattr(message, "reasoning", None)
            if not isinstance(reasoning_raw, str) or not reasoning_raw:
                model_extra = getattr(message, "model_extra", None) or {}
                if isinstance(model_extra, dict):
                    extra_reasoning = model_extra.get("reasoning")
                    if isinstance(extra_reasoning, str):
                        reasoning_raw = extra_reasoning
            if isinstance(reasoning_raw, str) and reasoning_raw:
                text = reasoning_raw
        if not text:
            finish_reason = getattr(choice, "finish_reason", None)
            raise ProviderResponseError(
                f"Cerebras returned an empty completion (finish_reason={finish_reason!r})."
            )
        usage: Any = getattr(response, "usage", None)
        return CompletionResponse(
            text=text,
            prompt_tokens=getattr(usage, "prompt_tokens", 0) if usage else 0,
            completion_tokens=getattr(usage, "completion_tokens", 0) if usage else 0,
            model=getattr(response, "model", request.model),
            raw={
                "provider": "cerebras",
                "finish_reason": getattr(choice, "finish_reason", None),
                "id": getattr(response, "id", None),
            },
        )


def register_cerebras_provider() -> bool:
    """Register :class:`CerebrasProvider` in CompactBench's provider registry.

    Returns
    -------
    bool
        ``True`` if registration succeeded, ``False`` if the registry is
        unavailable or sealed.
    """
    try:
        from compactbench import providers as _providers
    except ImportError:
        return False

    registry = getattr(_providers, "_REGISTRY", None)
    if not isinstance(registry, dict):
        return False
    registry[CerebrasProvider.key] = CerebrasProvider
    return True


__all__ = [
    "CEREBRAS_BASE_URL",
    "CEREBRAS_DEFAULT_MODEL",
    "CerebrasProvider",
    "register_cerebras_provider",
]
