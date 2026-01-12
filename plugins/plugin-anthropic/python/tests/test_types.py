"""Unit tests for elizaOS Plugin Anthropic types.

These tests do not require an API key.
"""

from __future__ import annotations

from elizaos_plugin_anthropic.models import Model, ModelSize
from elizaos_plugin_anthropic.types import (
    Message,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    Role,
    StopReason,
    TextContentBlock,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)


class TestModelSize:
    """Tests for ModelSize enum."""

    def test_model_size_values(self) -> None:
        assert ModelSize.SMALL.value == "small"
        assert ModelSize.LARGE.value == "large"


class TestModel:
    """Tests for Model class."""

    def test_model_creation(self) -> None:
        model = Model(Model.CLAUDE_3_5_HAIKU)
        assert model.id == Model.CLAUDE_3_5_HAIKU
        assert model.size == ModelSize.SMALL

    def test_small_model(self) -> None:
        model = Model.small()
        assert model.is_small()
        assert not model.is_large()

    def test_large_model(self) -> None:
        model = Model.large()
        assert model.is_large()
        assert not model.is_small()

    def test_haiku_models_are_small(self) -> None:
        haiku = Model(Model.CLAUDE_3_5_HAIKU)
        assert haiku.is_small()

        haiku_old = Model(Model.CLAUDE_3_HAIKU)
        assert haiku_old.is_small()

    def test_sonnet_models_are_large(self) -> None:
        sonnet = Model(Model.CLAUDE_SONNET_4)
        assert sonnet.is_large()

        sonnet_35 = Model(Model.CLAUDE_3_5_SONNET)
        assert sonnet_35.is_large()

    def test_opus_models_are_large(self) -> None:
        opus = Model(Model.CLAUDE_3_OPUS)
        assert opus.is_large()

    def test_max_tokens_by_model(self) -> None:
        # Claude 3 Haiku has 4096 max tokens
        haiku_3 = Model(Model.CLAUDE_3_HAIKU)
        # Claude 3.5+ models have 8192 max tokens
        sonnet = Model(Model.CLAUDE_SONNET_4)

        # Claude 3 models have smaller max tokens than 3.5+ models
        assert haiku_3.max_tokens() < sonnet.max_tokens()

    def test_model_string_representation(self) -> None:
        model = Model(Model.CLAUDE_3_5_HAIKU)
        assert str(model) == Model.CLAUDE_3_5_HAIKU


class TestRole:
    """Tests for Role enum."""

    def test_role_values(self) -> None:
        assert Role.USER.value == "user"
        assert Role.ASSISTANT.value == "assistant"


class TestStopReason:
    """Tests for StopReason enum."""

    def test_stop_reason_values(self) -> None:
        assert StopReason.END_TURN.value == "end_turn"
        assert StopReason.MAX_TOKENS.value == "max_tokens"
        assert StopReason.STOP_SEQUENCE.value == "stop_sequence"


class TestContentBlock:
    """Tests for ContentBlock classes."""

    def test_text_content_block(self) -> None:
        block = TextContentBlock(type="text", text_content="Hello, world!")
        assert block.type == "text"
        assert block.text_content == "Hello, world!"


class TestMessage:
    """Tests for Message class."""

    def test_user_message(self) -> None:
        message = Message.user("Hello!")
        assert message.role == Role.USER
        assert len(message.content) == 1
        assert message.content[0].get_text() == "Hello!"

    def test_assistant_message(self) -> None:
        message = Message.assistant("Hi there!")
        assert message.role == Role.ASSISTANT
        assert len(message.content) == 1
        assert message.content[0].get_text() == "Hi there!"


class TestTokenUsage:
    """Tests for TokenUsage class."""

    def test_token_usage(self) -> None:
        usage = TokenUsage(input_tokens=100, output_tokens=50)
        assert usage.input_tokens == 100
        assert usage.output_tokens == 50
        assert usage.total_tokens() == 150

    def test_token_usage_with_cache(self) -> None:
        usage = TokenUsage(
            input_tokens=100,
            output_tokens=50,
            cache_creation_input_tokens=20,
            cache_read_input_tokens=30,
        )
        assert usage.cache_creation_input_tokens == 20
        assert usage.cache_read_input_tokens == 30
        assert usage.total_tokens() == 150


class TestTextGenerationParams:
    """Tests for TextGenerationParams class."""

    def test_params_creation(self) -> None:
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.max_tokens is None
        assert params.temperature is None

    def test_params_with_options(self) -> None:
        params = TextGenerationParams(
            prompt="Hello",
            max_tokens=1000,
            temperature=0.7,
            system="You are helpful.",
        )
        assert params.prompt == "Hello"
        assert params.max_tokens == 1000
        assert params.temperature == 0.7
        assert params.system == "You are helpful."

    def test_params_builder_pattern(self) -> None:
        params = (
            TextGenerationParams(prompt="Hello")
            .with_max_tokens(500)
            .with_temperature(0.5)
            .with_system("Be brief.")
        )
        assert params.max_tokens == 500
        assert params.temperature == 0.5
        assert params.system == "Be brief."

    def test_params_with_top_p(self) -> None:
        params = TextGenerationParams(prompt="Hello").with_top_p(0.9)
        assert params.top_p == 0.9
        assert params.temperature is None


class TestTextGenerationResponse:
    """Tests for TextGenerationResponse class."""

    def test_response_creation(self) -> None:
        usage = TokenUsage(input_tokens=10, output_tokens=20)
        response = TextGenerationResponse(
            text="Hello!",
            model=Model.CLAUDE_3_5_HAIKU,
            stop_reason=StopReason.END_TURN,
            usage=usage,
        )
        assert response.text == "Hello!"
        assert response.model == Model.CLAUDE_3_5_HAIKU
        assert response.stop_reason == StopReason.END_TURN
        assert response.usage.total_tokens() == 30


class TestObjectGenerationParams:
    """Tests for ObjectGenerationParams class."""

    def test_params_creation(self) -> None:
        params = ObjectGenerationParams(prompt="Create a JSON object")
        assert params.prompt == "Create a JSON object"

    def test_params_with_schema(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name", "age"],
        }
        params = ObjectGenerationParams(prompt="Create a user", json_schema=schema)
        assert params.json_schema == schema


class TestObjectGenerationResponse:
    """Tests for ObjectGenerationResponse class."""

    def test_response_creation(self) -> None:
        usage = TokenUsage(input_tokens=10, output_tokens=20)
        response = ObjectGenerationResponse(
            object={"name": "John", "age": 30},
            model=Model.CLAUDE_3_5_HAIKU,
            usage=usage,
        )
        assert response.object == {"name": "John", "age": 30}
        assert response.model == Model.CLAUDE_3_5_HAIKU
        assert response.usage.total_tokens() == 30
