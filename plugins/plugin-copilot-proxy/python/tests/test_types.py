"""Tests for Copilot Proxy type definitions."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from elizaos_plugin_copilot_proxy.types import (
    ChatCompletionChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ChatRole,
    ModelInfo,
    ModelsResponse,
    TextGenerationParams,
    TextGenerationResult,
    TokenUsage,
)


class TestChatMessage:
    def test_system_message(self) -> None:
        msg = ChatMessage.system("You are helpful")
        assert msg.role == "system"
        assert msg.content == "You are helpful"

    def test_user_message(self) -> None:
        msg = ChatMessage.user("Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"

    def test_assistant_message(self) -> None:
        msg = ChatMessage.assistant("Hi there")
        assert msg.role == "assistant"
        assert msg.content == "Hi there"

    def test_content_defaults_to_none(self) -> None:
        msg = ChatMessage(role="user")
        assert msg.content is None

    def test_chat_role_enum_values(self) -> None:
        assert ChatRole.SYSTEM.value == "system"
        assert ChatRole.USER.value == "user"
        assert ChatRole.ASSISTANT.value == "assistant"


class TestChatCompletionRequest:
    def test_required_fields_only(self) -> None:
        req = ChatCompletionRequest(
            model="gpt-5-mini",
            messages=[ChatMessage.user("Hi")],
        )
        assert req.model == "gpt-5-mini"
        assert len(req.messages) == 1
        assert req.stream is False
        assert req.temperature is None
        assert req.max_tokens is None

    def test_serialization_excludes_none(self) -> None:
        req = ChatCompletionRequest(
            model="gpt-5-mini",
            messages=[ChatMessage.user("Hi")],
        )
        data = req.model_dump(exclude_none=True)
        assert "temperature" not in data
        assert "top_p" not in data
        assert "stop" not in data
        assert "model" in data


class TestTextGenerationParams:
    def test_prompt_required(self) -> None:
        params = TextGenerationParams(prompt="Write something")
        assert params.prompt == "Write something"
        assert params.model is None
        assert params.system is None
        assert params.temperature is None

    def test_with_all_options(self) -> None:
        params = TextGenerationParams(
            prompt="Write a poem",
            model="gpt-5.1",
            system="Be creative",
            temperature=0.8,
            max_tokens=1000,
            frequency_penalty=0.5,
            presence_penalty=-0.5,
            stop=["END"],
        )
        assert params.model == "gpt-5.1"
        assert params.temperature == 0.8
        assert params.stop == ["END"]

    def test_empty_prompt_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TextGenerationParams(prompt="")


class TestTextGenerationResult:
    def test_creation_without_usage(self) -> None:
        result = TextGenerationResult(text="Hello world")
        assert result.text == "Hello world"
        assert result.usage is None

    def test_creation_with_usage(self) -> None:
        usage = TokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        result = TextGenerationResult(text="Response", usage=usage)
        assert result.usage is not None
        assert result.usage.total_tokens == 15


class TestTokenUsage:
    def test_valid_usage(self) -> None:
        usage = TokenUsage(prompt_tokens=100, completion_tokens=50, total_tokens=150)
        assert usage.prompt_tokens == 100
        assert usage.completion_tokens == 50
        assert usage.total_tokens == 150

    def test_negative_prompt_tokens_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TokenUsage(prompt_tokens=-1, completion_tokens=0, total_tokens=0)


class TestModelInfo:
    def test_creation(self) -> None:
        info = ModelInfo(id="gpt-5-mini", created=1700000000, owned_by="copilot")
        assert info.id == "gpt-5-mini"
        assert info.object == "model"
        assert info.owned_by == "copilot"


class TestModelsResponse:
    def test_creation_with_models(self) -> None:
        model = ModelInfo(id="gpt-5-mini", created=1700000000, owned_by="copilot")
        resp = ModelsResponse(data=[model])
        assert resp.object == "list"
        assert len(resp.data) == 1
        assert resp.data[0].id == "gpt-5-mini"
