"""OpenAI-compatible client for a self-hosted vLLM server.

This module is intentionally a thin wrapper around the ``openai`` SDK so the
benchmarks package stays standalone. It does not import anything from the
training/serving code; it only speaks the OpenAI HTTP protocol.

A vLLM server started via ``vllm serve`` (or
``training/scripts/inference/serve_vllm.py``) exposes an
``/v1/chat/completions`` endpoint that is wire-compatible with OpenAI, so we
can point the standard ``openai.OpenAI`` client at it with a dummy API key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from openai import OpenAI


DEFAULT_BASE_URL = "http://127.0.0.1:8001/v1"
DEFAULT_API_KEY = "dummy"


@dataclass(frozen=True)
class VLLMConfig:
    base_url: str
    api_key: str
    model: str


class VLLMProvider:
    """Tiny OpenAI-compatible client targeting a self-hosted vLLM endpoint.

    Construct with ``base_url``/``api_key``/``model``. Call ``chat_completion``
    with a list of OpenAI-shaped messages and an optional list of tool specs.
    Returns the raw response as a dict.
    """

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str = DEFAULT_API_KEY,
        model: str,
        timeout: float | None = None,
    ) -> None:
        if not model:
            raise ValueError("VLLMProvider requires a non-empty model name")
        self.config = VLLMConfig(base_url=base_url, api_key=api_key, model=model)
        client_kwargs: dict[str, Any] = {"base_url": base_url, "api_key": api_key}
        if timeout is not None:
            client_kwargs["timeout"] = timeout
        self._client = OpenAI(**client_kwargs)

    @classmethod
    def from_env(cls, *, model: str | None = None) -> "VLLMProvider":
        """Construct from ``VLLM_BASE_URL`` / ``VLLM_API_KEY`` / ``VLLM_MODEL``."""
        resolved_model = model or os.environ.get("VLLM_MODEL", "")
        return cls(
            base_url=os.environ.get("VLLM_BASE_URL", DEFAULT_BASE_URL),
            api_key=os.environ.get("VLLM_API_KEY", DEFAULT_API_KEY),
            model=resolved_model,
        )

    @property
    def model(self) -> str:
        return self.config.model

    @property
    def base_url(self) -> str:
        return self.config.base_url

    def chat_completion(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Call ``/v1/chat/completions`` and return the raw response as a dict.

        ``messages`` must be OpenAI chat-completions shape (``role``/``content``).
        ``tools`` is optional and must follow the OpenAI tool-spec format.
        Any additional keyword arguments are forwarded to the underlying SDK
        call (e.g. ``max_tokens``, ``top_p``, ``response_format``).
        """
        request: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
        }
        if tools:
            request["tools"] = tools
        request.update(kwargs)
        completion = self._client.chat.completions.create(**request)
        return completion.model_dump()


__all__ = ["VLLMProvider", "VLLMConfig", "DEFAULT_BASE_URL", "DEFAULT_API_KEY"]
