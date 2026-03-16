"""Unit tests for Vercel AI Gateway plugin using mocks."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from elizaos_plugin_gateway import GatewayConfig, GatewayPlugin
from elizaos_plugin_gateway.client import GatewayClient, GatewayClientError
from elizaos_plugin_gateway.config import model_supports_temperature
from elizaos_plugin_gateway.types import (
    ChatChoice,
    ChatCompletionResponse,
    ChatMessage,
    EmbeddingData,
    EmbeddingParams,
    EmbeddingResponse,
    ImageDescriptionParams,
    ImageGenerationParams,
    ImageQuality,
    ImageSize,
    ImageStyle,
    TextGenerationParams,
    TokenUsage,
)

if TYPE_CHECKING:
    pass


# =============================================================================
# Config Tests
# =============================================================================


class TestGatewayConfig:
    """Tests for GatewayConfig."""

    def test_config_with_defaults(self) -> None:
        """Test config with default values."""
        config = GatewayConfig(api_key="test-key")
        assert config.api_key == "test-key"
        assert config.base_url == "https://ai-gateway.vercel.sh/v1"
        assert config.small_model == "gpt-5-mini"
        assert config.large_model == "gpt-5"
        assert config.embedding_model == "text-embedding-3-small"
        assert config.embedding_dimensions == 1536
        assert config.image_model == "dall-e-3"
        assert config.timeout == 60.0

    def test_config_with_custom_values(self) -> None:
        """Test config with custom values."""
        config = GatewayConfig(
            api_key="custom-key",
            base_url="https://custom.api.com/v1",
            small_model="custom-small",
            large_model="custom-large",
            embedding_model="custom-embedding",
            embedding_dimensions=768,
            image_model="custom-image",
            timeout=120.0,
        )
        assert config.api_key == "custom-key"
        assert config.base_url == "https://custom.api.com/v1"
        assert config.small_model == "custom-small"
        assert config.large_model == "custom-large"
        assert config.embedding_model == "custom-embedding"
        assert config.embedding_dimensions == 768
        assert config.image_model == "custom-image"
        assert config.timeout == 120.0

    def test_config_from_env(self) -> None:
        """Test config from environment variables."""
        with patch.dict(
            "os.environ",
            {
                "AI_GATEWAY_API_KEY": "env-key",
                "AI_GATEWAY_BASE_URL": "https://env.api.com/v1",
                "AI_GATEWAY_SMALL_MODEL": "env-small",
                "AI_GATEWAY_LARGE_MODEL": "env-large",
            },
        ):
            config = GatewayConfig.from_env()
            assert config.api_key == "env-key"
            assert config.base_url == "https://env.api.com/v1"
            assert config.small_model == "env-small"
            assert config.large_model == "env-large"

    def test_config_from_env_missing_key(self) -> None:
        """Test config from env without API key raises error."""
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="must be set"):
                GatewayConfig.from_env()

    def test_model_supports_temperature(self) -> None:
        """Test model_supports_temperature function."""
        # Models that don't support temperature
        assert not model_supports_temperature("o1")
        assert not model_supports_temperature("o1-preview")
        assert not model_supports_temperature("o1-mini")
        assert not model_supports_temperature("o3")
        assert not model_supports_temperature("o3-mini")
        assert not model_supports_temperature("gpt-5")
        assert not model_supports_temperature("gpt-5-mini")

        # Models that support temperature
        assert model_supports_temperature("gpt-5")
        assert model_supports_temperature("gpt-5")
        assert model_supports_temperature("claude-3")
        assert model_supports_temperature("custom-model")


# =============================================================================
# Types Tests
# =============================================================================


class TestTypes:
    """Tests for type models."""

    def test_text_generation_params(self) -> None:
        """Test TextGenerationParams validation."""
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.model is None
        assert params.stream is False

    def test_text_generation_params_with_options(self) -> None:
        """Test TextGenerationParams with all options."""
        params = TextGenerationParams(
            prompt="Hello",
            model="gpt-5",
            system="Be helpful",
            temperature=0.7,
            max_tokens=100,
            stream=True,
        )
        assert params.prompt == "Hello"
        assert params.model == "gpt-5"
        assert params.system == "Be helpful"
        assert params.temperature == 0.7
        assert params.max_tokens == 100
        assert params.stream is True

    def test_embedding_params(self) -> None:
        """Test EmbeddingParams validation."""
        params = EmbeddingParams(text="Hello world")
        assert params.text == "Hello world"
        assert params.model is None
        assert params.dimensions is None

    def test_image_generation_params(self) -> None:
        """Test ImageGenerationParams validation."""
        params = ImageGenerationParams(prompt="A cat")
        assert params.prompt == "A cat"
        assert params.n == 1
        assert params.size == ImageSize.SIZE_1024
        assert params.quality == ImageQuality.STANDARD
        assert params.style == ImageStyle.VIVID

    def test_chat_completion_response(self) -> None:
        """Test ChatCompletionResponse parsing."""
        response = ChatCompletionResponse(
            id="test-id",
            created=1234567890,
            model="gpt-5",
            choices=[
                ChatChoice(
                    index=0,
                    message=ChatMessage(role="assistant", content="Hello!"),
                    finish_reason="stop",
                )
            ],
            usage=TokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
        )
        assert response.id == "test-id"
        assert response.choices[0].message.content == "Hello!"
        assert response.usage is not None
        assert response.usage.total_tokens == 15

    def test_embedding_response(self) -> None:
        """Test EmbeddingResponse parsing."""
        response = EmbeddingResponse(
            data=[
                EmbeddingData(
                    embedding=[0.1, 0.2, 0.3],
                    index=0,
                )
            ],
            model="text-embedding-3-small",
            usage=TokenUsage(prompt_tokens=5, total_tokens=5),
        )
        assert len(response.data) == 1
        assert response.data[0].embedding == [0.1, 0.2, 0.3]


# =============================================================================
# Client Tests
# =============================================================================


class TestGatewayClient:
    """Tests for GatewayClient."""

    @pytest.fixture
    def config(self) -> GatewayConfig:
        """Create test config."""
        return GatewayConfig(api_key="test-key")

    @pytest.fixture
    def client(self, config: GatewayConfig) -> GatewayClient:
        """Create test client."""
        return GatewayClient(config)

    @pytest.mark.asyncio
    async def test_generate_text(self, client: GatewayClient) -> None:
        """Test text generation."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello, world!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = TextGenerationParams(prompt="Say hello")
            result = await client.generate_text(params)
            assert result == "Hello, world!"

    @pytest.mark.asyncio
    async def test_generate_text_with_system_message(self, client: GatewayClient) -> None:
        """Test text generation with system message."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Bonjour!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 15, "completion_tokens": 2, "total_tokens": 17},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ) as mock_post:
            params = TextGenerationParams(
                prompt="Say hello",
                system="Always respond in French",
            )
            result = await client.generate_text(params)
            assert result == "Bonjour!"

            # Verify system message was included
            call_args = mock_post.call_args
            assert call_args is not None
            request_body = call_args[1]["json"]
            assert len(request_body["messages"]) == 2
            assert request_body["messages"][0]["role"] == "system"
            assert request_body["messages"][0]["content"] == "Always respond in French"

    @pytest.mark.asyncio
    async def test_generate_text_no_choices(self, client: GatewayClient) -> None:
        """Test text generation with no choices raises error."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = TextGenerationParams(prompt="Say hello")
            with pytest.raises(GatewayClientError, match="no choices"):
                await client.generate_text(params)

    @pytest.mark.asyncio
    async def test_generate_text_empty_content(self, client: GatewayClient) -> None:
        """Test text generation with empty content raises error."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": None},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = TextGenerationParams(prompt="Say hello")
            with pytest.raises(GatewayClientError, match="empty content"):
                await client.generate_text(params)

    @pytest.mark.asyncio
    async def test_create_embedding(self, client: GatewayClient) -> None:
        """Test embedding creation."""
        mock_response = {
            "object": "list",
            "data": [
                {
                    "object": "embedding",
                    "embedding": [0.1, 0.2, 0.3, 0.4, 0.5],
                    "index": 0,
                }
            ],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 5, "total_tokens": 5},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = EmbeddingParams(text="Hello world")
            result = await client.create_embedding(params)
            assert result == [0.1, 0.2, 0.3, 0.4, 0.5]

    @pytest.mark.asyncio
    async def test_create_embedding_empty_data(self, client: GatewayClient) -> None:
        """Test embedding creation with empty data raises error."""
        mock_response = {
            "object": "list",
            "data": [],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 5, "total_tokens": 5},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = EmbeddingParams(text="Hello world")
            with pytest.raises(GatewayClientError, match="empty embedding"):
                await client.create_embedding(params)

    @pytest.mark.asyncio
    async def test_generate_image(self, client: GatewayClient) -> None:
        """Test image generation."""
        mock_response = {
            "created": 1234567890,
            "data": [
                {
                    "url": "https://example.com/image.png",
                    "revised_prompt": "A beautiful cat",
                }
            ],
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = ImageGenerationParams(prompt="A cat")
            result = await client.generate_image(params)
            assert len(result) == 1
            assert result[0].url == "https://example.com/image.png"
            assert result[0].revised_prompt == "A beautiful cat"

    @pytest.mark.asyncio
    async def test_describe_image(self, client: GatewayClient) -> None:
        """Test image description."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Title: A Cat\n\nA fluffy orange cat sitting on a couch.",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = ImageDescriptionParams(image_url="https://example.com/cat.jpg")
            result = await client.describe_image(params)
            assert result.title == "A Cat"
            assert "fluffy orange cat" in result.description

    @pytest.mark.asyncio
    async def test_generate_object(self, client: GatewayClient) -> None:
        """Test object generation."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": '{"name": "John", "age": 30}',
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            result = await client.generate_object("Return a JSON object with name and age")
            assert result == {"name": "John", "age": 30}

    @pytest.mark.asyncio
    async def test_generate_object_with_code_block(self, client: GatewayClient) -> None:
        """Test object generation with markdown code block."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": '```json\n{"name": "Jane", "age": 25}\n```',
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 20, "completion_tokens": 15, "total_tokens": 35},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            result = await client.generate_object("Return a JSON object with name and age")
            assert result == {"name": "Jane", "age": 25}

    @pytest.mark.asyncio
    async def test_api_error_handling(self, client: GatewayClient) -> None:
        """Test API error handling."""
        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = False
        mock_http_response.status_code = 401
        mock_http_response.text = "Unauthorized"
        mock_http_response.json.return_value = {"error": {"message": "Invalid API key"}}

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = TextGenerationParams(prompt="Hello")
            with pytest.raises(GatewayClientError) as exc_info:
                await client.generate_text(params)
            assert exc_info.value.status_code == 401
            assert "Invalid API key" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_close(self, client: GatewayClient) -> None:
        """Test client close."""
        with patch.object(client._client, "aclose", new_callable=AsyncMock) as mock_close:
            await client.close()
            mock_close.assert_called_once()


# =============================================================================
# Plugin Tests
# =============================================================================


class TestGatewayPlugin:
    """Tests for GatewayPlugin."""

    @pytest.fixture
    def mock_env(self) -> dict[str, str]:
        """Set up mock environment."""
        return {"AI_GATEWAY_API_KEY": "test-key"}

    @pytest.mark.asyncio
    async def test_plugin_init(self) -> None:
        """Test plugin initialization."""
        plugin = GatewayPlugin(api_key="test-key")
        assert plugin._config.api_key == "test-key"
        await plugin.close()

    @pytest.mark.asyncio
    async def test_plugin_init_from_env(self) -> None:
        """Test plugin initialization from environment."""
        with patch.dict("os.environ", {"AI_GATEWAY_API_KEY": "env-key"}):
            plugin = GatewayPlugin()
            assert plugin._config.api_key == "env-key"
            await plugin.close()

    @pytest.mark.asyncio
    async def test_plugin_init_no_key(self) -> None:
        """Test plugin initialization without key raises error."""
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="must be provided"):
                GatewayPlugin()

    @pytest.mark.asyncio
    async def test_plugin_context_manager(self) -> None:
        """Test plugin as context manager."""
        with patch.object(GatewayClient, "close", new_callable=AsyncMock) as mock_close:
            async with GatewayPlugin(api_key="test-key") as plugin:
                assert plugin._config.api_key == "test-key"
            mock_close.assert_called_once()

    @pytest.mark.asyncio
    async def test_generate_text_small(self) -> None:
        """Test generate_text_small method."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello there!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        async with GatewayPlugin(api_key="test-key") as plugin:
            with patch.object(
                plugin._client._client,
                "post",
                new_callable=AsyncMock,
                return_value=mock_http_response,
            ) as mock_post:
                result = await plugin.generate_text_small("Say hello")
                assert result == "Hello there!"

                # Verify the small model was used
                call_args = mock_post.call_args
                assert call_args is not None
                request_body = call_args[1]["json"]
                assert request_body["model"] == "gpt-5-mini"

    @pytest.mark.asyncio
    async def test_generate_text_large(self) -> None:
        """Test generate_text_large method."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Greetings, human!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        async with GatewayPlugin(api_key="test-key") as plugin:
            with patch.object(
                plugin._client._client,
                "post",
                new_callable=AsyncMock,
                return_value=mock_http_response,
            ) as mock_post:
                result = await plugin.generate_text_large("Say hello")
                assert result == "Greetings, human!"

                # Verify the large model was used
                call_args = mock_post.call_args
                assert call_args is not None
                request_body = call_args[1]["json"]
                assert request_body["model"] == "gpt-5"

    @pytest.mark.asyncio
    async def test_create_embedding(self) -> None:
        """Test create_embedding method."""
        mock_response = {
            "object": "list",
            "data": [
                {
                    "object": "embedding",
                    "embedding": [0.1, 0.2, 0.3],
                    "index": 0,
                }
            ],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 5, "total_tokens": 5},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        async with GatewayPlugin(api_key="test-key") as plugin:
            with patch.object(
                plugin._client._client,
                "post",
                new_callable=AsyncMock,
                return_value=mock_http_response,
            ):
                result = await plugin.create_embedding("Hello world")
                assert result == [0.1, 0.2, 0.3]

    @pytest.mark.asyncio
    async def test_generate_object(self) -> None:
        """Test generate_object method."""
        mock_response = {
            "id": "test-id",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "gpt-5-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": '{"result": "success"}',
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 15, "completion_tokens": 5, "total_tokens": 20},
        }

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = True
        mock_http_response.json.return_value = mock_response

        async with GatewayPlugin(api_key="test-key") as plugin:
            with patch.object(
                plugin._client._client,
                "post",
                new_callable=AsyncMock,
                return_value=mock_http_response,
            ):
                result = await plugin.generate_object("Return a JSON object")
                assert result == {"result": "success"}


# =============================================================================
# Streaming Tests
# =============================================================================


class TestStreaming:
    """Tests for streaming functionality."""

    @pytest.fixture
    def config(self) -> GatewayConfig:
        """Create test config."""
        return GatewayConfig(api_key="test-key")

    @pytest.fixture
    def client(self, config: GatewayConfig) -> GatewayClient:
        """Create test client."""
        return GatewayClient(config)

    @pytest.mark.asyncio
    async def test_stream_text(self, client: GatewayClient) -> None:
        """Test streaming text generation."""

        # Create mock async iterator for streaming
        async def mock_aiter_lines() -> list[str]:
            lines = [
                'data: {"choices": [{"delta": {"content": "Hello"}}]}',
                'data: {"choices": [{"delta": {"content": " world"}}]}',
                'data: {"choices": [{"delta": {"content": "!"}}]}',
                "data: [DONE]",
            ]
            for line in lines:
                yield line

        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.aiter_lines = mock_aiter_lines

        mock_context = AsyncMock()
        mock_context.__aenter__.return_value = mock_response
        mock_context.__aexit__.return_value = None

        with patch.object(client._client, "stream", return_value=mock_context):
            params = TextGenerationParams(prompt="Say hello", stream=True)
            chunks: list[str] = []
            async for chunk in client.stream_text(params):
                chunks.append(chunk)

            assert chunks == ["Hello", " world", "!"]
            assert "".join(chunks) == "Hello world!"

    @pytest.mark.asyncio
    async def test_plugin_stream_text(self) -> None:
        """Test plugin streaming text generation."""

        async def mock_aiter_lines() -> list[str]:
            lines = [
                'data: {"choices": [{"delta": {"content": "1"}}]}',
                'data: {"choices": [{"delta": {"content": ", "}}]}',
                'data: {"choices": [{"delta": {"content": "2"}}]}',
                'data: {"choices": [{"delta": {"content": ", "}}]}',
                'data: {"choices": [{"delta": {"content": "3"}}]}',
                "data: [DONE]",
            ]
            for line in lines:
                yield line

        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.aiter_lines = mock_aiter_lines

        mock_context = AsyncMock()
        mock_context.__aenter__.return_value = mock_response
        mock_context.__aexit__.return_value = None

        async with GatewayPlugin(api_key="test-key") as plugin:
            with patch.object(plugin._client._client, "stream", return_value=mock_context):
                chunks: list[str] = []
                async for chunk in plugin.stream_text("Count from 1 to 3"):
                    chunks.append(chunk)

                assert "".join(chunks) == "1, 2, 3"


# =============================================================================
# Edge Cases and Error Handling
# =============================================================================


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    @pytest.mark.asyncio
    async def test_api_error_json_decode_failure(self) -> None:
        """Test API error when JSON decode fails."""
        config = GatewayConfig(api_key="test-key")
        client = GatewayClient(config)

        mock_http_response = MagicMock(spec=httpx.Response)
        mock_http_response.is_success = False
        mock_http_response.status_code = 500
        mock_http_response.text = "Internal Server Error"
        mock_http_response.json.side_effect = json.JSONDecodeError("msg", "doc", 0)

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_http_response
        ):
            params = TextGenerationParams(prompt="Hello")
            with pytest.raises(GatewayClientError) as exc_info:
                await client.generate_text(params)
            assert exc_info.value.status_code == 500
            assert "Internal Server Error" in str(exc_info.value)

        await client.close()

    def test_gateway_client_error_without_status_code(self) -> None:
        """Test GatewayClientError without status code."""
        error = GatewayClientError("Test error")
        assert str(error) == "Test error"
        assert error.status_code is None

    def test_gateway_client_error_with_status_code(self) -> None:
        """Test GatewayClientError with status code."""
        error = GatewayClientError("Test error", status_code=404)
        assert str(error) == "Test error"
        assert error.status_code == 404
