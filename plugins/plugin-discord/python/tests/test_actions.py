"""Tests for actions."""

import pytest

from elizaos_plugin_discord.actions import (
    ActionContext,
    ActionResult,
    get_all_actions,
)
from elizaos_plugin_discord.actions.add_reaction import AddReactionAction
from elizaos_plugin_discord.actions.send_dm import SendDmAction
from elizaos_plugin_discord.actions.send_message import SendMessageAction


class TestActionResult:
    """Tests for ActionResult."""

    def test_success_result(self) -> None:
        """Test creating a success result."""
        result = ActionResult.success_result("Done")
        assert result.success is True
        assert result.response == "Done"
        assert result.data is None

    def test_success_result_with_data(self) -> None:
        """Test creating a success result with data."""
        result = ActionResult.success_result("Done", {"key": "value"})
        assert result.success is True
        assert result.data == {"key": "value"}

    def test_failure_result(self) -> None:
        """Test creating a failure result."""
        result = ActionResult.failure_result("Error occurred")
        assert result.success is False
        assert result.response == "Error occurred"


class TestSendMessageAction:
    """Tests for SendMessageAction."""

    @pytest.mark.asyncio
    async def test_validate_valid(self) -> None:
        """Test validation with valid context."""
        action = SendMessageAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {"text": "Hello!"},
            },
            channel_id="123456789012345678",
            guild_id="987654321098765432",
            user_id="111222333444555666",
        )

        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_wrong_source(self) -> None:
        """Test validation with wrong source."""
        action = SendMessageAction()
        context = ActionContext(
            message={
                "source": "telegram",
                "content": {"text": "Hello!"},
            },
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )

        assert await action.validate(context) is False

    @pytest.mark.asyncio
    async def test_validate_missing_content(self) -> None:
        """Test validation with missing content."""
        action = SendMessageAction()
        context = ActionContext(
            message={"source": "discord"},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )

        assert await action.validate(context) is False


class TestSendDmAction:
    """Tests for SendDmAction."""

    @pytest.mark.asyncio
    async def test_validate_with_target(self) -> None:
        """Test validation with target user."""
        action = SendDmAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {
                    "text": "Hello!",
                    "target_user_id": "999888777666555444",
                },
            },
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )

        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_without_target(self) -> None:
        """Test validation without target (uses sender)."""
        action = SendDmAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {"text": "Hello back!"},
            },
            channel_id="123456789012345678",
            guild_id=None,
            user_id="123456789012345678",  # Valid snowflake
        )

        assert await action.validate(context) is True


class TestAddReactionAction:
    """Tests for AddReactionAction."""

    @pytest.mark.asyncio
    async def test_validate_valid(self) -> None:
        """Test validation with valid context."""
        action = AddReactionAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {
                    "message_id": "123456789012345678",
                    "emoji": "👍",
                },
            },
            channel_id="987654321098765432",
            guild_id="111222333444555666",
            user_id="999888777666555444",
        )

        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_missing_emoji(self) -> None:
        """Test validation with missing emoji."""
        action = AddReactionAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {"message_id": "123456789012345678"},
            },
            channel_id="987654321098765432",
            guild_id=None,
            user_id="999888777666555444",
        )

        assert await action.validate(context) is False


class TestGetAllActions:
    """Tests for get_all_actions."""

    def test_get_all_actions(self) -> None:
        """Test that all actions are returned."""
        actions = get_all_actions()
        assert len(actions) == 18

        names = [a.name for a in actions]
        # Core messaging actions
        assert "SEND_MESSAGE" in names
        assert "SEND_DM" in names
        assert "ADD_REACTION" in names
        # Additional actions
        assert "CHAT_WITH_ATTACHMENTS" in names
        assert "CREATE_POLL" in names
        assert "DOWNLOAD_MEDIA" in names
        assert "GET_USER_INFO" in names
        assert "JOIN_CHANNEL" in names
        assert "LEAVE_CHANNEL" in names
        assert "LIST_CHANNELS" in names
        assert "PIN_MESSAGE" in names
        assert "REACT_TO_MESSAGE" in names
        assert "READ_CHANNEL" in names
        assert "SEARCH_MESSAGES" in names
        assert "SERVER_INFO" in names
        assert "SUMMARIZE_CONVERSATION" in names
        assert "TRANSCRIBE_MEDIA" in names
        assert "UNPIN_MESSAGE" in names


# ---------------------------------------------------------------------------
# Read channel action tests
# ---------------------------------------------------------------------------


class TestReadChannelAction:
    """Tests for ReadChannelAction."""

    @pytest.mark.asyncio
    async def test_validate_discord_source(self) -> None:
        """Test validation passes for discord source."""
        from elizaos_plugin_discord.actions.read_channel import ReadChannelAction

        action = ReadChannelAction()
        context = ActionContext(
            message={"source": "discord", "content": {"text": "read channel"}},
            channel_id="123456789012345678",
            guild_id="987654321098765432",
            user_id="111222333444555666",
        )
        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_non_discord_source(self) -> None:
        """Test validation fails for non-discord source."""
        from elizaos_plugin_discord.actions.read_channel import ReadChannelAction

        action = ReadChannelAction()
        context = ActionContext(
            message={"source": "slack", "content": {"text": "read channel"}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )
        assert await action.validate(context) is False


class TestSearchMessagesAction:
    """Tests for SearchMessagesAction."""

    @pytest.mark.asyncio
    async def test_validate_discord_source(self) -> None:
        """Test validation passes for discord source."""
        from elizaos_plugin_discord.actions.search_messages import SearchMessagesAction

        action = SearchMessagesAction()
        context = ActionContext(
            message={"source": "discord", "content": {"text": "search hello"}},
            channel_id="123456789012345678",
            guild_id="987654321098765432",
            user_id="111222333444555666",
        )
        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_non_discord_source(self) -> None:
        """Test validation fails for non-discord source."""
        from elizaos_plugin_discord.actions.search_messages import SearchMessagesAction

        action = SearchMessagesAction()
        context = ActionContext(
            message={"source": "api", "content": {"text": "search hello"}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )
        assert await action.validate(context) is False


# ---------------------------------------------------------------------------
# Edit message action tests
# ---------------------------------------------------------------------------


class TestEditMessageAction:
    """Tests for EditMessageAction."""

    @pytest.mark.asyncio
    async def test_validate_discord_source_with_state(self) -> None:
        """Test validation passes with proper state."""
        from elizaos_plugin_discord.actions.edit_message import EditMessageAction

        action = EditMessageAction()
        context = ActionContext(
            message={"source": "discord", "content": {}},
            channel_id="123456789012345678",
            guild_id="987654321098765432",
            user_id="111222333444555666",
            state={"message_id": "123456789012345678", "new_text": "updated content"},
        )
        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_fails_without_message_id(self) -> None:
        """Test validation fails when message_id is missing."""
        from elizaos_plugin_discord.actions.edit_message import EditMessageAction

        action = EditMessageAction()
        context = ActionContext(
            message={"source": "discord", "content": {}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
            state={"new_text": "updated content"},
        )
        assert await action.validate(context) is False

    @pytest.mark.asyncio
    async def test_validate_fails_without_new_text(self) -> None:
        """Test validation fails when new_text is missing."""
        from elizaos_plugin_discord.actions.edit_message import EditMessageAction

        action = EditMessageAction()
        context = ActionContext(
            message={"source": "discord", "content": {}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
            state={"message_id": "123456789012345678"},
        )
        assert await action.validate(context) is False

    @pytest.mark.asyncio
    async def test_validate_non_discord_source(self) -> None:
        """Test validation fails for non-discord source."""
        from elizaos_plugin_discord.actions.edit_message import EditMessageAction

        action = EditMessageAction()
        context = ActionContext(
            message={"source": "telegram", "content": {}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
            state={"message_id": "123456789012345678", "new_text": "updated"},
        )
        assert await action.validate(context) is False


# ---------------------------------------------------------------------------
# Delete message action tests
# ---------------------------------------------------------------------------


class TestDeleteMessageAction:
    """Tests for DeleteMessageAction."""

    @pytest.mark.asyncio
    async def test_validate_discord_source_with_message_id(self) -> None:
        """Test validation passes with message_id in state."""
        from elizaos_plugin_discord.actions.delete_message import DeleteMessageAction

        action = DeleteMessageAction()
        context = ActionContext(
            message={"source": "discord", "content": {}},
            channel_id="123456789012345678",
            guild_id="987654321098765432",
            user_id="111222333444555666",
            state={"message_id": "123456789012345678"},
        )
        assert await action.validate(context) is True

    @pytest.mark.asyncio
    async def test_validate_fails_without_message_id(self) -> None:
        """Test validation fails when message_id is missing."""
        from elizaos_plugin_discord.actions.delete_message import DeleteMessageAction

        action = DeleteMessageAction()
        context = ActionContext(
            message={"source": "discord", "content": {}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )
        assert await action.validate(context) is False

    @pytest.mark.asyncio
    async def test_validate_non_discord_source(self) -> None:
        """Test validation fails for non-discord source."""
        from elizaos_plugin_discord.actions.delete_message import DeleteMessageAction

        action = DeleteMessageAction()
        context = ActionContext(
            message={"source": "api", "content": {"message_id": "123456789012345678"}},
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )
        assert await action.validate(context) is False

    @pytest.mark.asyncio
    async def test_validate_message_id_in_content(self) -> None:
        """Test validation passes when message_id is in content."""
        from elizaos_plugin_discord.actions.delete_message import DeleteMessageAction

        action = DeleteMessageAction()
        context = ActionContext(
            message={
                "source": "discord",
                "content": {"message_id": "123456789012345678"},
            },
            channel_id="123456789012345678",
            guild_id=None,
            user_id="111222333444555666",
        )
        assert await action.validate(context) is True


# ---------------------------------------------------------------------------
# Action property tests
# ---------------------------------------------------------------------------


class TestActionProperties:
    """Tests for action metadata properties."""

    def test_edit_message_properties(self) -> None:
        """Test EditMessageAction metadata."""
        from elizaos_plugin_discord.actions.edit_message import EditMessageAction

        action = EditMessageAction()
        assert action.name == "DISCORD_EDIT_MESSAGE"
        assert "edit" in action.description.lower()
        assert len(action.similes) > 0

    def test_delete_message_properties(self) -> None:
        """Test DeleteMessageAction metadata."""
        from elizaos_plugin_discord.actions.delete_message import DeleteMessageAction

        action = DeleteMessageAction()
        assert action.name == "DISCORD_DELETE_MESSAGE"
        assert "delete" in action.description.lower()
        assert len(action.similes) > 0

    def test_all_actions_have_required_properties(self) -> None:
        """Test that all actions have name, description, similes, validate, handler."""
        actions = get_all_actions()
        for action in actions:
            assert hasattr(action, "name"), f"Action missing name"
            assert hasattr(action, "description"), f"{action.name} missing description"
            assert hasattr(action, "similes"), f"{action.name} missing similes"
            assert hasattr(action, "validate"), f"{action.name} missing validate"
            assert hasattr(action, "handler"), f"{action.name} missing handler"
