"""Tests for xAI plugin services."""

import pytest

from elizaos_plugin_xai.services.message_service import IMessageService, MessageService
from elizaos_plugin_xai.services.post_service import IPostService, PostService


# ============================================================================
# MessageService
# ============================================================================


class TestMessageService:
    """Tests for MessageService."""

    @pytest.fixture
    def mock_runtime(self):
        class MockRuntime:
            agent_id = "test-agent"

        return MockRuntime()

    def test_construction(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        assert service is not None
        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_start(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        await service.start()
        assert service.is_running is True

    @pytest.mark.asyncio
    async def test_stop(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        await service.start()
        await service.stop()
        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_send_message(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        result = await service.send_message("user-123", "Hello!")
        assert result["sent"] is True
        assert result["recipient_id"] == "user-123"
        assert result["text"] == "Hello!"

    @pytest.mark.asyncio
    async def test_get_messages_empty(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        result = await service.get_messages()
        assert result == []

    @pytest.mark.asyncio
    async def test_get_messages_with_conversation(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        result = await service.get_messages("conv-123")
        assert isinstance(result, list)

    def test_implements_interface(self, mock_runtime) -> None:
        service = MessageService(mock_runtime)
        assert isinstance(service, IMessageService)


# ============================================================================
# PostService
# ============================================================================


class TestPostService:
    """Tests for PostService."""

    @pytest.fixture
    def mock_runtime(self):
        class MockRuntime:
            agent_id = "test-agent"

        return MockRuntime()

    def test_construction(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        assert service is not None
        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_start(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        await service.start()
        assert service.is_running is True

    @pytest.mark.asyncio
    async def test_stop(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        await service.start()
        await service.stop()
        assert service.is_running is False

    @pytest.mark.asyncio
    async def test_create_post(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        result = await service.create_post("Hello world!")
        assert result["created"] is True
        assert result["text"] == "Hello world!"

    @pytest.mark.asyncio
    async def test_create_post_with_reply(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        result = await service.create_post("Reply text", reply_to="post-123")
        assert result["reply_to"] == "post-123"

    @pytest.mark.asyncio
    async def test_get_post(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        result = await service.get_post("post-123")
        assert result is None  # Placeholder returns None

    @pytest.mark.asyncio
    async def test_like_post(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        result = await service.like_post("post-123")
        assert result is True

    @pytest.mark.asyncio
    async def test_repost(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        result = await service.repost("post-123")
        assert result is True

    def test_implements_interface(self, mock_runtime) -> None:
        service = PostService(mock_runtime)
        assert isinstance(service, IPostService)
