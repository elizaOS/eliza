"""
Shared test fixtures for the Slack plugin test suite.
"""

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from elizaos_plugin_slack.types import (
    SlackChannel,
    SlackChannelPurpose,
    SlackChannelTopic,
    SlackFile,
    SlackMessage,
    SlackReaction,
    SlackSettings,
    SlackUser,
    SlackUserProfile,
    SLACK_SERVICE_NAME,
)


# ---------------------------------------------------------------------------
# Factory helpers – construct realistic Slack domain objects
# ---------------------------------------------------------------------------

def make_user_profile(**overrides) -> SlackUserProfile:
    defaults = dict(
        title="Engineer",
        phone=None,
        skype=None,
        real_name="Jane Smith",
        real_name_normalized="Jane Smith",
        display_name="janesmith",
        display_name_normalized="janesmith",
        status_text="Working",
        status_emoji=":computer:",
        status_expiration=None,
        avatar_hash="abc123",
        email="jane@example.com",
        image_24="https://img/24.png",
        image_32="https://img/32.png",
        image_48="https://img/48.png",
        image_72="https://img/72.png",
        image_192="https://img/192.png",
        image_512="https://img/512.png",
        image_1024=None,
        image_original=None,
        team="T0123456789",
    )
    defaults.update(overrides)
    return SlackUserProfile(**defaults)


def make_user(**overrides) -> SlackUser:
    defaults = dict(
        id="U0123456789",
        name="janesmith",
        profile=make_user_profile(),
        team_id="T0123456789",
        deleted=False,
        real_name="Jane Smith",
        tz="America/New_York",
        tz_label="Eastern Standard Time",
        tz_offset=-18000,
        is_admin=False,
        is_owner=False,
        is_primary_owner=False,
        is_restricted=False,
        is_ultra_restricted=False,
        is_bot=False,
        is_app_user=False,
        updated=1700000000,
    )
    defaults.update(overrides)
    return SlackUser(**defaults)


def make_channel(**overrides) -> SlackChannel:
    defaults = dict(
        id="C0123456789",
        name="general",
        created=1600000000,
        creator="U0000000001",
        is_channel=True,
        is_group=False,
        is_im=False,
        is_mpim=False,
        is_private=False,
        is_archived=False,
        is_general=True,
        is_shared=False,
        is_org_shared=False,
        is_member=True,
        topic=SlackChannelTopic(value="General discussion", creator="U0000000001", last_set=1600000000),
        purpose=SlackChannelPurpose(value="Company-wide channel", creator="U0000000001", last_set=1600000000),
        num_members=42,
    )
    defaults.update(overrides)
    return SlackChannel(**defaults)


def make_message(**overrides) -> SlackMessage:
    defaults = dict(
        type="message",
        ts="1700000000.000001",
        text="Hello from Slack!",
        subtype=None,
        user="U0123456789",
        thread_ts=None,
        reply_count=None,
        reply_users_count=None,
        latest_reply=None,
        reactions=None,
        files=None,
        attachments=None,
        blocks=None,
    )
    defaults.update(overrides)
    return SlackMessage(**defaults)


# ---------------------------------------------------------------------------
# Mock runtime / message / state
# ---------------------------------------------------------------------------

class MockRoom:
    """Minimal mock of a Room object used by actions and providers."""
    def __init__(self, channel_id="C0123456789", world_id=None, metadata=None):
        self.channel_id = channel_id
        self.world_id = world_id
        self.metadata = metadata or {}


class MockWorld:
    def __init__(self, name="Test Workspace", metadata=None):
        self.name = name
        self.metadata = metadata or {"domain": "test-workspace"}


@pytest.fixture
def mock_slack_service():
    """A MagicMock that mimics the SlackService public API."""
    svc = MagicMock()
    svc.client = MagicMock()  # truthy – service is available
    svc.bot_user_id = "U_BOT_001"
    svc.team_id = "T0123456789"

    svc.get_bot_user_id = MagicMock(return_value="U_BOT_001")
    svc.get_team_id = MagicMock(return_value="T0123456789")
    svc.is_service_connected = MagicMock(return_value=True)
    svc.get_allowed_channel_ids = MagicMock(return_value=[])

    # Async methods
    svc.send_message = AsyncMock(return_value={"ts": "1700000000.000099", "channel_id": "C0123456789"})
    svc.send_reaction = AsyncMock()
    svc.remove_reaction = AsyncMock()
    svc.edit_message = AsyncMock()
    svc.delete_message = AsyncMock()
    svc.pin_message = AsyncMock()
    svc.unpin_message = AsyncMock()
    svc.list_pins = AsyncMock(return_value=[make_message()])
    svc.read_history = AsyncMock(return_value=[make_message()])
    svc.list_channels = AsyncMock(return_value=[make_channel()])
    svc.get_channel = AsyncMock(return_value=make_channel())
    svc.get_user = AsyncMock(return_value=make_user())
    svc.get_emoji_list = AsyncMock(return_value={"custom1": "https://emoji/1.png", "alias1": "alias:custom1"})

    return svc


@pytest.fixture
def mock_runtime(mock_slack_service):
    """A MagicMock that mimics the elizaOS runtime."""
    rt = MagicMock()
    rt.get_service = MagicMock(return_value=mock_slack_service)
    rt.get_room = AsyncMock(return_value=MockRoom())
    rt.get_world = AsyncMock(return_value=MockWorld())
    rt.character = SimpleNamespace(settings={})

    def _get_setting(key):
        settings_map = {
            "SLACK_BOT_TOKEN": "xoxb-test-token",
            "SLACK_APP_TOKEN": "xapp-test-token",
            "SLACK_SIGNING_SECRET": "test-signing-secret",
            "SLACK_USER_TOKEN": None,
            "SLACK_CHANNEL_IDS": "",
            "SLACK_SHOULD_IGNORE_BOT_MESSAGES": "false",
            "SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS": "false",
        }
        return settings_map.get(key)

    rt.get_setting = MagicMock(side_effect=_get_setting)
    return rt


@pytest.fixture
def slack_message():
    """A mock message object whose .content dict contains source=slack."""
    msg = MagicMock()
    msg.content = {"source": "slack", "text": "test message"}
    msg.room_id = "room-001"
    return msg


@pytest.fixture
def non_slack_message():
    """A mock message whose source is NOT slack."""
    msg = MagicMock()
    msg.content = {"source": "discord", "text": "test message"}
    msg.room_id = "room-002"
    return msg


@pytest.fixture
def mock_state():
    """A mock state object with room data."""
    state = MagicMock()
    state.data = {"room": MockRoom()}
    state.agent_name = "TestBot"
    state.sender_name = "TestUser"
    return state


@pytest.fixture
def mock_callback():
    """An AsyncMock usable as an action callback."""
    return AsyncMock()
