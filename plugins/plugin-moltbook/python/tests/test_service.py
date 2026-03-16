"""Tests for MoltbookService."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_moltbook.constants import CONTENT_LIMITS, MOLTBOOK_SERVICE_NAME, URLS
from elizaos_plugin_moltbook.services.moltbook import MoltbookService
from elizaos_plugin_moltbook.types import (
    MoltbookAuthenticationError,
    MoltbookConfigurationError,
    MoltbookContentTooLongError,
)


class MockRuntime:
    """Mock runtime for testing purposes."""

    def __init__(self, settings: dict[str, str | None] | None = None) -> None:
        self._settings = settings or {}

    def get_setting(self, key: str) -> str | None:
        return self._settings.get(key)


@pytest.fixture
def test_runtime() -> MockRuntime:
    return MockRuntime(
        {
            "MOLTBOOK_TOKEN": "test-token",
            "MOLTBOOK_AGENT_NAME": "TestAgent",
        }
    )


@pytest.fixture
def runtime_no_token() -> MockRuntime:
    return MockRuntime(
        {
            "MOLTBOOK_AGENT_NAME": "TestAgent",
        }
    )


class TestMoltbookServiceInit:
    def test_init_with_token(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)
        assert service.config.agent_name == "TestAgent"
        assert service.config.moltbook_token == "test-token"
        assert service.service_type == MOLTBOOK_SERVICE_NAME

    def test_init_without_token(self, runtime_no_token: MockRuntime) -> None:
        service = MoltbookService(runtime_no_token)
        assert service.config.moltbook_token is None

    def test_init_with_default_agent_name(self) -> None:
        runtime = MockRuntime({})
        service = MoltbookService(runtime)
        assert service.config.agent_name == "Agent"

    def test_init_with_empty_agent_name_uses_default(self) -> None:
        runtime = MockRuntime({"MOLTBOOK_AGENT_NAME": ""})
        # Empty string falls through to "Agent" default
        service = MoltbookService(runtime)
        assert service.config.agent_name == "Agent"

    def test_init_with_autonomy_settings(self) -> None:
        runtime = MockRuntime({
            "MOLTBOOK_AGENT_NAME": "Bot",
            "MOLTBOOK_AUTONOMOUS_MODE": "true",
            "MOLTBOOK_AUTONOMY_INTERVAL_MS": "60000",
            "MOLTBOOK_AUTONOMY_MAX_STEPS": "50",
        })
        service = MoltbookService(runtime)
        assert service.config.autonomous_mode is True
        assert service.config.autonomy_interval_ms == 60000
        assert service.config.autonomy_max_steps == 50

    def test_init_with_autonomy_disabled(self) -> None:
        runtime = MockRuntime({
            "MOLTBOOK_AGENT_NAME": "Bot",
            "MOLTBOOK_AUTONOMOUS_MODE": "false",
        })
        service = MoltbookService(runtime)
        assert service.config.autonomous_mode is False

    def test_autonomy_not_running_by_default(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)
        assert service.is_autonomy_running() is False

    @pytest.mark.asyncio
    async def test_start_creates_service(self, test_runtime: MockRuntime) -> None:
        service = await MoltbookService.start(test_runtime)
        assert service is not None
        assert service.config.agent_name == "TestAgent"


class TestMoltbookServicePost:
    def test_post_without_token_raises(self, runtime_no_token: MockRuntime) -> None:
        service = MoltbookService(runtime_no_token)
        with pytest.raises(MoltbookAuthenticationError, match="MOLTBOOK_TOKEN not set"):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                service.moltbook_post("iq", "Title", "Content")
            )

    def test_post_title_too_long_raises(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)
        long_title = "x" * (CONTENT_LIMITS["max_title_length"] + 1)
        with pytest.raises(MoltbookContentTooLongError, match="Title exceeds"):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                service.moltbook_post("iq", long_title, "Content")
            )

    def test_post_content_too_long_raises(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)
        long_content = "x" * (CONTENT_LIMITS["max_content_length"] + 1)
        with pytest.raises(MoltbookContentTooLongError, match="Content exceeds"):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                service.moltbook_post("iq", "Title", long_content)
            )

    @pytest.mark.asyncio
    async def test_post_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {"post": {"id": "post-123"}},
        )

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response

            post_id = await service.moltbook_post("iq", "Test Post", "This is content")
            assert post_id == "post-123"

    @pytest.mark.asyncio
    async def test_post_api_error(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=400,
            json=lambda: {"error": "Bad request"},
        )

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response

            from elizaos_plugin_moltbook.types import MoltbookAPIError
            with pytest.raises(MoltbookAPIError, match="Bad request"):
                await service.moltbook_post("iq", "Test", "Content")


class TestMoltbookServiceBrowse:
    @pytest.mark.asyncio
    async def test_browse_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {
                "posts": [
                    {
                        "id": "post-1",
                        "title": "First Post",
                        "upvotes": 10,
                        "comment_count": 2,
                    },
                    {
                        "id": "post-2",
                        "title": "Second Post",
                        "upvotes": 5,
                        "comment_count": 1,
                    },
                ]
            },
        )
        mock_response.is_success = True

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_browse(None, "hot")
            assert result.success is True
            assert len(result.data) == 2
            assert result.data[0]["title"] == "First Post"

    @pytest.mark.asyncio
    async def test_browse_with_submolt(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {"posts": []},
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_browse("iq", "hot")
            assert result.success is True
            assert result.data == []

    @pytest.mark.asyncio
    async def test_browse_api_error(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=500,
            text="Internal Server Error",
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_browse(None, "hot")
            assert result.success is False
            assert "500" in (result.error or "")


class TestMoltbookServiceComment:
    @pytest.mark.asyncio
    async def test_comment_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {"id": "comment-456"},
        )

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response

            comment_id = await service.moltbook_comment("post-1", "Great post!")
            assert comment_id == "comment-456"

    @pytest.mark.asyncio
    async def test_reply_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {"id": "reply-789"},
        )

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = mock_response

            reply_id = await service.moltbook_reply("post-1", "comment-1", "Thanks!")
            assert reply_id == "reply-789"

    def test_comment_without_token_raises(self, runtime_no_token: MockRuntime) -> None:
        service = MoltbookService(runtime_no_token)
        with pytest.raises(MoltbookAuthenticationError):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                service.moltbook_comment("post-1", "Comment")
            )

    def test_comment_too_long_raises(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)
        long_comment = "x" * (CONTENT_LIMITS["max_comment_length"] + 1)
        with pytest.raises(MoltbookContentTooLongError, match="Comment exceeds"):
            import asyncio
            asyncio.get_event_loop().run_until_complete(
                service.moltbook_comment("post-1", long_comment)
            )


class TestMoltbookServiceReadPost:
    @pytest.mark.asyncio
    async def test_read_post_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {
                "post": {
                    "id": "post-1",
                    "title": "Test Post",
                    "content": "Hello",
                    "upvotes": 10,
                    "comment_count": 2,
                },
                "comments": [
                    {"id": "c1", "content": "Nice!", "author": {"name": "Bot1"}},
                    {"id": "c2", "content": "Thanks!", "parent_id": "c1"},
                ],
            },
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_read_post("post-1")
            assert result.post["title"] == "Test Post"
            assert len(result.comments) == 2
            assert result.comments[0]["content"] == "Nice!"

    @pytest.mark.asyncio
    async def test_read_post_not_found(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {},
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            from elizaos_plugin_moltbook.types import MoltbookAPIError
            with pytest.raises(MoltbookAPIError, match="Post not found"):
                await service.moltbook_read_post("nonexistent")


class TestMoltbookServiceSubmolts:
    @pytest.mark.asyncio
    async def test_list_submolts_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {
                "submolts": [
                    {"id": "s1", "name": "iq", "subscriber_count": 100},
                    {"id": "s2", "name": "crypto", "subscriber_count": 50},
                ]
            },
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_list_submolts("popular")
            assert result.success is True
            assert len(result.data) == 2

    @pytest.mark.asyncio
    async def test_get_submolt_success(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(
            status_code=200,
            json=lambda: {
                "submolt": {
                    "id": "s1",
                    "name": "iq",
                    "description": "IQ discussions",
                    "subscriber_count": 100,
                }
            },
        )

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_get_submolt("iq")
            assert result.success is True
            assert result.data["name"] == "iq"

    @pytest.mark.asyncio
    async def test_get_submolt_not_found(self, test_runtime: MockRuntime) -> None:
        service = MoltbookService(test_runtime)

        mock_response = MagicMock(status_code=404)

        with patch.object(service._client, "get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_response

            result = await service.moltbook_get_submolt("nonexistent")
            assert result.success is True
            assert result.data is None
