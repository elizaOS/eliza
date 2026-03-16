import pytest

from elizaos_plugin_instagram.actions.post_comment import (
    PostCommentAction,
)
from elizaos_plugin_instagram.actions.send_dm import (
    ActionContext,
    SendDmAction,
)


class TestSendDmAction:
    @pytest.fixture
    def action(self) -> SendDmAction:
        return SendDmAction()

    @pytest.mark.asyncio
    async def test_name(self, action: SendDmAction) -> None:
        assert action.name == "SEND_INSTAGRAM_DM"

    @pytest.mark.asyncio
    async def test_description(self, action: SendDmAction) -> None:
        assert "Instagram" in action.description

    @pytest.mark.asyncio
    async def test_validate_instagram_source(self, action: SendDmAction) -> None:
        context = ActionContext(
            message={"source": "instagram", "text": "Hello"},
            user_id=12345,
            thread_id="thread-1",
            media_id=None,
            state={},
        )
        result = await action.validate(context)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_non_instagram_source(self, action: SendDmAction) -> None:
        context = ActionContext(
            message={"source": "telegram", "text": "Hello"},
            user_id=12345,
            thread_id="thread-1",
            media_id=None,
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_no_thread(self, action: SendDmAction) -> None:
        context = ActionContext(
            message={"source": "instagram", "text": "Hello"},
            user_id=12345,
            thread_id=None,
            media_id=None,
            state={},
        )
        result = await action.validate(context)
        assert result is False


class TestPostCommentAction:
    @pytest.fixture
    def action(self) -> PostCommentAction:
        return PostCommentAction()

    @pytest.mark.asyncio
    async def test_name(self, action: PostCommentAction) -> None:
        assert action.name == "POST_INSTAGRAM_COMMENT"

    @pytest.mark.asyncio
    async def test_validate_with_media(self, action: PostCommentAction) -> None:
        context = ActionContext(
            message={"source": "instagram", "text": "Nice post!"},
            user_id=12345,
            thread_id=None,
            media_id=67890,
            state={},
        )
        result = await action.validate(context)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_no_media(self, action: PostCommentAction) -> None:
        context = ActionContext(
            message={"source": "instagram", "text": "Nice post!"},
            user_id=12345,
            thread_id=None,
            media_id=None,
            state={},
        )
        result = await action.validate(context)
        assert result is False
