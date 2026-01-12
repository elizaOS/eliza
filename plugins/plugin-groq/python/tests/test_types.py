import pytest
from pydantic import ValidationError

from elizaos_plugin_groq.types import (
    ChatMessage,
    GenerateTextParams,
    GroqConfig,
    MessageRole,
)


class TestGenerateTextParams:
    def test_minimal(self) -> None:
        params = GenerateTextParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.temperature is None

    def test_full(self) -> None:
        params = GenerateTextParams(
            prompt="Hello",
            system="You are helpful",
            temperature=0.7,
            max_tokens=1024,
        )
        assert params.system == "You are helpful"
        assert params.temperature == 0.7

    def test_temperature_bounds(self) -> None:
        with pytest.raises(ValidationError):
            GenerateTextParams(prompt="test", temperature=3.0)


class TestChatMessage:
    def test_user(self) -> None:
        msg = ChatMessage(role=MessageRole.USER, content="Hello")
        assert msg.role == MessageRole.USER

    def test_system(self) -> None:
        msg = ChatMessage(role=MessageRole.SYSTEM, content="Be helpful")
        assert msg.role == MessageRole.SYSTEM


class TestGroqConfig:
    def test_defaults(self) -> None:
        config = GroqConfig(api_key="test-key")
        assert config.api_key == "test-key"
        assert config.small_model == "llama-3.1-8b-instant"
        assert config.large_model == "llama-3.3-70b-versatile"

    def test_custom(self) -> None:
        config = GroqConfig(api_key="key", base_url="https://custom.api.com")
        assert config.base_url == "https://custom.api.com"
