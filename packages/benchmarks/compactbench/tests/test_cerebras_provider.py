"""Tests for the Cerebras provider's response handling and registration.

These do not hit a real Cerebras endpoint — they monkeypatch
``self._client.chat.completions.create`` to return canned response shapes
that mirror what the real API has been observed to emit, including the
content-vs-reasoning fallback case for ``gpt-oss-120b``.
"""

from __future__ import annotations

from typing import Any

import pytest
from compactbench.providers.base import CompletionRequest
from compactbench.providers.errors import ProviderResponseError

from eliza_compactbench import cerebras_provider


class _StubChoice:
    def __init__(self, message: Any, finish_reason: str = "stop") -> None:
        self.message = message
        self.finish_reason = finish_reason


class _StubMessage:
    def __init__(
        self,
        content: str | None = None,
        reasoning: str | None = None,
        model_extra: dict[str, Any] | None = None,
    ) -> None:
        self.content = content
        self.reasoning = reasoning
        self.model_extra = model_extra


class _StubUsage:
    def __init__(self, prompt: int, completion: int) -> None:
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _StubResponse:
    def __init__(self, choices: list[_StubChoice], usage: _StubUsage | None = None) -> None:
        self.choices = choices
        self.usage = usage
        self.model = "gpt-oss-120b"
        self.id = "stub-id"


def _make_provider(monkeypatch: pytest.MonkeyPatch) -> cerebras_provider.CerebrasProvider:
    monkeypatch.setenv("CEREBRAS_API_KEY", "test-key")
    return cerebras_provider.CerebrasProvider()


async def test_provider_returns_content_when_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _make_provider(monkeypatch)
    response = _StubResponse(
        choices=[_StubChoice(_StubMessage(content="hello world"))],
        usage=_StubUsage(10, 2),
    )

    async def fake_create(**_kwargs: Any) -> Any:
        return response

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)
    result = await provider.complete(
        CompletionRequest(model="gpt-oss-120b", prompt="hi")
    )
    assert result.text == "hello world"
    assert result.prompt_tokens == 10
    assert result.completion_tokens == 2


async def test_provider_falls_back_to_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """gpt-oss-120b on Cerebras occasionally returns the answer entirely in
    message.reasoning with empty content. Mirror the TS bridge fix.
    """
    provider = _make_provider(monkeypatch)
    response = _StubResponse(
        choices=[
            _StubChoice(
                _StubMessage(content="", reasoning="the answer is 42"),
                finish_reason="stop",
            )
        ],
        usage=_StubUsage(5, 8),
    )

    async def fake_create(**_kwargs: Any) -> Any:
        return response

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)
    result = await provider.complete(
        CompletionRequest(model="gpt-oss-120b", prompt="hi")
    )
    assert result.text == "the answer is 42"


async def test_provider_falls_back_to_model_extra_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the SDK doesn't surface ``reasoning`` as a typed attribute,
    the value lands in pydantic's model_extra dict. Honor that path too.
    """
    provider = _make_provider(monkeypatch)
    msg = _StubMessage(content=None, reasoning=None, model_extra={"reasoning": "via extras"})
    response = _StubResponse(
        choices=[_StubChoice(msg, finish_reason="stop")],
        usage=_StubUsage(1, 1),
    )

    async def fake_create(**_kwargs: Any) -> Any:
        return response

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)
    result = await provider.complete(
        CompletionRequest(model="gpt-oss-120b", prompt="hi")
    )
    assert result.text == "via extras"


async def test_provider_raises_when_both_channels_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _make_provider(monkeypatch)
    response = _StubResponse(
        choices=[
            _StubChoice(_StubMessage(content="", reasoning=None), finish_reason="length")
        ],
        usage=_StubUsage(5, 0),
    )

    async def fake_create(**_kwargs: Any) -> Any:
        return response

    monkeypatch.setattr(provider._client.chat.completions, "create", fake_create)
    with pytest.raises(ProviderResponseError) as excinfo:
        await provider.complete(CompletionRequest(model="gpt-oss-120b", prompt="hi"))
    assert "finish_reason='length'" in str(excinfo.value)


def test_register_cerebras_provider_is_idempotent() -> None:
    """Calling register twice must not raise and must leave the registry
    pointing at our class.
    """
    from compactbench import providers as _providers

    assert cerebras_provider.register_cerebras_provider() is True
    assert cerebras_provider.register_cerebras_provider() is True
    registry = _providers._REGISTRY
    assert registry["cerebras"] is cerebras_provider.CerebrasProvider
