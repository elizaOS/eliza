"""Tests for Moltbook actions."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_moltbook.actions.base import Action
from elizaos_plugin_moltbook.actions.browse import moltbook_browse_action
from elizaos_plugin_moltbook.actions.comment import moltbook_comment_action
from elizaos_plugin_moltbook.actions.post import moltbook_post_action
from elizaos_plugin_moltbook.actions.read import moltbook_read_action
from elizaos_plugin_moltbook.actions.submolts import moltbook_submolts_action
from elizaos_plugin_moltbook.constants import MOLTBOOK_SERVICE_NAME
from elizaos_plugin_moltbook.types import MoltbookResult, PostWithComments


class MockRuntime:
    """Mock runtime for testing actions."""

    def __init__(
        self,
        service: object | None = None,
        settings: dict[str, str | None] | None = None,
    ) -> None:
        self._service = service
        self._settings = settings or {}

    def get_setting(self, key: str) -> str | None:
        return self._settings.get(key)

    def get_service(self, name: str) -> object | None:
        if name == MOLTBOOK_SERVICE_NAME:
            return self._service
        return None


# ==================== Action Registration Tests ====================


class TestActionRegistration:
    def test_post_action_metadata(self) -> None:
        assert isinstance(moltbook_post_action, Action)
        assert moltbook_post_action.name == "MOLTBOOK_POST"
        assert "POST_MOLTBOOK" in moltbook_post_action.similes
        assert len(moltbook_post_action.examples) == 2

    def test_browse_action_metadata(self) -> None:
        assert isinstance(moltbook_browse_action, Action)
        assert moltbook_browse_action.name == "MOLTBOOK_BROWSE"
        assert "BROWSE_MOLTBOOK" in moltbook_browse_action.similes

    def test_comment_action_metadata(self) -> None:
        assert isinstance(moltbook_comment_action, Action)
        assert moltbook_comment_action.name == "MOLTBOOK_COMMENT"
        assert "COMMENT_MOLTBOOK" in moltbook_comment_action.similes

    def test_read_action_metadata(self) -> None:
        assert isinstance(moltbook_read_action, Action)
        assert moltbook_read_action.name == "MOLTBOOK_READ"
        assert "READ_MOLTBOOK_POST" in moltbook_read_action.similes

    def test_submolts_action_metadata(self) -> None:
        assert isinstance(moltbook_submolts_action, Action)
        assert moltbook_submolts_action.name == "MOLTBOOK_SUBMOLTS"
        assert "LIST_SUBMOLTS" in moltbook_submolts_action.similes
        assert len(moltbook_submolts_action.examples) == 4


# ==================== Validate Tests ====================


class TestPostValidation:
    @pytest.mark.asyncio
    async def test_validate_no_service_returns_false(self) -> None:
        runtime = MockRuntime(service=None)
        message = {"content": {"text": "post on moltbook"}}
        result = await moltbook_post_action.validate(runtime, message, None)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_with_service_and_keyword(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        message = {"content": {"text": "post something on moltbook"}}
        result = await moltbook_post_action.validate(runtime, message, None)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_no_keyword_returns_false(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        message = {"content": {"text": "moltbook is great"}}
        result = await moltbook_post_action.validate(runtime, message, None)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_no_moltbook_returns_false(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        message = {"content": {"text": "post something on reddit"}}
        result = await moltbook_post_action.validate(runtime, message, None)
        assert result is False


class TestBrowseValidation:
    @pytest.mark.asyncio
    async def test_validate_browse_keywords(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)

        for keyword in ("browse", "check", "explore", "trending"):
            message = {"content": {"text": f"{keyword} moltbook"}}
            result = await moltbook_browse_action.validate(runtime, message, None)
            assert result is True, f"Expected True for keyword '{keyword}'"


class TestCommentValidation:
    @pytest.mark.asyncio
    async def test_validate_comment_keywords(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)

        for keyword in ("comment", "reply", "respond"):
            message = {"content": {"text": f"{keyword} on moltbook"}}
            result = await moltbook_comment_action.validate(runtime, message, None)
            assert result is True, f"Expected True for keyword '{keyword}'"


class TestReadValidation:
    @pytest.mark.asyncio
    async def test_validate_read_keywords(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)

        for phrase in ("read post", "view post", "show post"):
            message = {"content": {"text": f"moltbook {phrase}"}}
            result = await moltbook_read_action.validate(runtime, message, None)
            assert result is True, f"Expected True for phrase '{phrase}'"


class TestSubmoltsValidation:
    @pytest.mark.asyncio
    async def test_validate_submolts_keywords(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)

        for keyword in ("list submolt", "show submolt", "explore submolt"):
            message = {"content": {"text": keyword}}
            result = await moltbook_submolts_action.validate(runtime, message, None)
            assert result is True, f"Expected True for keyword '{keyword}'"


# ==================== Handler Tests ====================


class TestPostHandler:
    @pytest.mark.asyncio
    async def test_handler_no_service(self) -> None:
        runtime = MockRuntime(service=None)
        result = await moltbook_post_action.handler(runtime, {}, None, None, None)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_handler_missing_title(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        result = await moltbook_post_action.handler(
            runtime, {}, None, {"content": "Hello"}, None
        )
        assert result["success"] is False
        assert "title" in result["text"].lower() or "Missing" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_success(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_post = AsyncMock(return_value="post-123")
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_post_action.handler(
            runtime, {}, None,
            {"title": "Test Post", "content": "Hello", "submolt": "iq"},
            None,
        )
        assert result["success"] is True
        assert "post-123" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_with_callback(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_post = AsyncMock(return_value="post-999")
        runtime = MockRuntime(service=mock_service)
        callback = AsyncMock()

        await moltbook_post_action.handler(
            runtime, {}, None,
            {"title": "Test", "content": "Content", "submolt": "iq"},
            callback,
        )
        callback.assert_called_once()
        call_args = callback.call_args[0][0]
        assert "post-999" in call_args["text"]


class TestBrowseHandler:
    @pytest.mark.asyncio
    async def test_handler_success(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_browse = AsyncMock(
            return_value=MoltbookResult(
                success=True,
                data=[
                    {"id": "p1", "title": "Post 1", "upvotes": 5, "comment_count": 1},
                ],
            )
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_browse_action.handler(runtime, {}, None, None, None)
        assert result["success"] is True
        assert "Post 1" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_empty_posts(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_browse = AsyncMock(
            return_value=MoltbookResult(success=True, data=[])
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_browse_action.handler(runtime, {}, None, None, None)
        assert result["success"] is True
        assert "No posts" in result["text"]


class TestCommentHandler:
    @pytest.mark.asyncio
    async def test_handler_missing_params(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        result = await moltbook_comment_action.handler(runtime, {}, None, {}, None)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_handler_comment_success(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_comment = AsyncMock(return_value="comment-123")
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_comment_action.handler(
            runtime, {}, None,
            {"postId": "post-1", "content": "Great!"},
            None,
        )
        assert result["success"] is True
        assert "comment-123" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_reply_success(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_reply = AsyncMock(return_value="reply-456")
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_comment_action.handler(
            runtime, {}, None,
            {"postId": "post-1", "parentId": "comment-1", "content": "Thanks!"},
            None,
        )
        assert result["success"] is True
        assert "reply-456" in result["text"]


class TestReadHandler:
    @pytest.mark.asyncio
    async def test_handler_missing_post_id(self) -> None:
        mock_service = MagicMock()
        runtime = MockRuntime(service=mock_service)
        result = await moltbook_read_action.handler(runtime, {}, None, {}, None)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_handler_read_success(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_read_post = AsyncMock(
            return_value=PostWithComments(
                post={
                    "id": "p1",
                    "title": "Test Post",
                    "content": "Hello world",
                    "upvotes": 10,
                    "comment_count": 1,
                },
                comments=[{"id": "c1", "content": "Nice!", "author": {"name": "Bot1"}}],
            )
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_read_action.handler(
            runtime, {}, None, {"postId": "p1"}, None
        )
        assert result["success"] is True
        assert "Test Post" in result["text"]
        assert "Nice!" in result["text"]


class TestSubmoltsHandler:
    @pytest.mark.asyncio
    async def test_handler_list_submolts(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_list_submolts = AsyncMock(
            return_value=MoltbookResult(
                success=True,
                data=[
                    {"id": "s1", "name": "iq", "subscriber_count": 100},
                    {"id": "s2", "name": "crypto", "subscriber_count": 50},
                ],
            )
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_submolts_action.handler(runtime, {}, None, None, None)
        assert result["success"] is True
        assert "m/iq" in result["text"]
        assert "m/crypto" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_examine_submolt(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_get_submolt = AsyncMock(
            return_value=MoltbookResult(
                success=True,
                data={
                    "id": "s1",
                    "name": "iq",
                    "description": "IQ discussions",
                    "subscriber_count": 100,
                    "post_count": 50,
                },
            )
        )
        mock_service.moltbook_browse = AsyncMock(
            return_value=MoltbookResult(success=True, data=[])
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_submolts_action.handler(
            runtime, {}, None, {"submolt": "iq"}, None
        )
        assert result["success"] is True
        assert "m/iq" in result["text"]
        assert "IQ discussions" in result["text"]

    @pytest.mark.asyncio
    async def test_handler_submolt_not_found(self) -> None:
        mock_service = MagicMock()
        mock_service.moltbook_get_submolt = AsyncMock(
            return_value=MoltbookResult(success=True, data=None)
        )
        runtime = MockRuntime(service=mock_service)

        result = await moltbook_submolts_action.handler(
            runtime, {}, None, {"submolt": "nonexistent"}, None
        )
        assert result["success"] is False
        assert "not found" in result["text"]


# ==================== Plugin Integration Tests ====================


class TestPluginIntegration:
    def test_plugin_has_all_actions(self) -> None:
        from elizaos_plugin_moltbook.plugin import moltbook_plugin

        action_names = [a.name for a in moltbook_plugin.actions]
        assert "MOLTBOOK_POST" in action_names
        assert "MOLTBOOK_BROWSE" in action_names
        assert "MOLTBOOK_COMMENT" in action_names
        assert "MOLTBOOK_READ" in action_names
        assert "MOLTBOOK_SUBMOLTS" in action_names
        assert len(action_names) == 5

    def test_plugin_has_provider(self) -> None:
        from elizaos_plugin_moltbook.plugin import moltbook_plugin

        provider_names = [p.name for p in moltbook_plugin.providers]
        assert "MOLTBOOK_STATE" in provider_names
        assert len(provider_names) == 1

    def test_plugin_has_service(self) -> None:
        from elizaos_plugin_moltbook.plugin import moltbook_plugin

        assert len(moltbook_plugin.services) == 1

    def test_plugin_metadata(self) -> None:
        from elizaos_plugin_moltbook.plugin import moltbook_plugin

        assert moltbook_plugin.name == "@elizaos/plugin-moltbook-py"
        assert "Moltbook" in moltbook_plugin.description
