"""Abstract base + shared dataclasses for inference clients.

All concrete clients (Cerebras, Anthropic, Hermes) implement ``BaseClient.complete``
and return a uniform ``ClientResponse`` shape so the benchmark runner can swap
backends without per-provider branching.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Literal

FinishReason = Literal["stop", "tool_calls", "length", "content_filter", "error"]
ReasoningEffort = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class Usage:
    """Token-level accounting for a single completion call.

    ``cached_tokens`` is kept for legacy callers; new code reads
    ``cache_read_input_tokens`` and ``cache_creation_input_tokens`` directly.
    The two cache fields are ``None`` when the provider did not report them
    (e.g. providers that do not support prompt caching at all). Per AGENTS.md
    Cmd #8: nullable cache fields stay nullable — no silent ``0`` fallback for
    missing data.

    Cache wire shapes per provider:

    * OpenAI / Cerebras OpenAI-compatible: ``usage.prompt_tokens_details
      .cached_tokens`` (Cerebras serves gpt-oss-120b with prompt caching
      default-on, 128-token blocks).
    * Anthropic: ``usage.cache_read_input_tokens`` and
      ``usage.cache_creation_input_tokens``.
    """

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: int = 0
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None


@dataclass(frozen=True)
class ToolCall:
    """A single tool call requested by the model."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ClientResponse:
    """Uniform response shape across providers."""

    content: str | None
    tool_calls: list[ToolCall]
    finish_reason: FinishReason
    usage: Usage
    latency_ms: int
    cost_usd: float
    raw_provider_response: dict[str, Any]


@dataclass(frozen=True)
class ClientCall:
    """Inputs for a single completion call.

    ``messages`` and ``tools`` are in OpenAI chat-completions shape. Each client
    is responsible for translating to its provider's wire format.
    """

    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    temperature: float = 0.0
    max_tokens: int | None = None
    reasoning_effort: ReasoningEffort = "low"
    extra: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    """Raised when a provider returns a non-2xx response or transport fails.

    ``status`` is None when the failure happened before an HTTP response was
    received (DNS, timeout, etc). ``body`` is the raw response body when
    available.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None,
        body: str | None,
        provider: str,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.provider = provider


class BaseClient(abc.ABC):
    """Abstract inference client. Concrete subclasses implement ``complete``."""

    model_name: str

    @abc.abstractmethod
    async def complete(self, call: ClientCall) -> ClientResponse:
        """Run a single completion. Must be async and must not swallow errors."""
        raise NotImplementedError
