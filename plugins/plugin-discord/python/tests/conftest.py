"""Pytest configuration and fixtures for Discord plugin tests."""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Callable, Coroutine
from typing import TYPE_CHECKING, TypeVar
from unittest.mock import MagicMock

# Type variables for generic mock classes
T = TypeVar("T")


# =============================================================================
# Mock Discord Classes - Defined BEFORE installing mock module
# =============================================================================


class MockIntents:
    """Mock Discord Intents class."""

    message_content: bool = False
    guilds: bool = False
    guild_messages: bool = False
    dm_messages: bool = False
    guild_voice_states: bool = False
    guild_reactions: bool = False
    members: bool = False

    @staticmethod
    def default() -> MockIntents:
        return MockIntents()


class MockUser:
    """Mock Discord User class."""

    def __init__(
        self,
        user_id: int = 123456789,
        name: str = "TestUser",
        discriminator: str = "0001",
        bot: bool = False,
    ) -> None:
        self.id = user_id
        self.name = name
        self.discriminator = discriminator
        self.bot = bot

    async def send(self, content: str) -> MockMessage:
        msg = MockMessage()
        msg.content = content
        return msg


class MockMember:
    """Mock Discord Member class."""

    def __init__(
        self,
        user_id: int = 123456789,
        name: str = "TestMember",
        display_name: str = "Test Member",
    ) -> None:
        self.id = user_id
        self.name = name
        self.display_name = display_name
        self.guild = MockGuild()
        self.roles: list[MockRole] = []
        self.joined_at = None


class MockRole:
    """Mock Discord Role class."""

    def __init__(self, role_id: int = 111222333, name: str = "TestRole") -> None:
        self.id = role_id
        self.name = name


class MockColor:
    """Mock Discord Color class."""

    def __init__(self, value: int = 0) -> None:
        self.value = value


class MockAttachment:
    """Mock Discord Attachment class."""

    def __init__(self) -> None:
        self.id = 999888777
        self.filename = "test.png"
        self.size = 1024
        self.url = "https://example.com/test.png"
        self.proxy_url = "https://proxy.example.com/test.png"
        self.content_type = "image/png"
        self.height = 100
        self.width = 100


class MockEmbedFooter:
    """Mock Discord EmbedFooter class."""

    def __init__(self) -> None:
        self.text: str | None = None
        self.icon_url: str | None = None


class MockEmbedMedia:
    """Mock Discord EmbedMedia class."""

    def __init__(self) -> None:
        self.url: str | None = None
        self.proxy_url: str | None = None
        self.height: int | None = None
        self.width: int | None = None


class MockEmbedAuthor:
    """Mock Discord EmbedAuthor class."""

    def __init__(self) -> None:
        self.name: str | None = None
        self.url: str | None = None
        self.icon_url: str | None = None


class MockEmbedField:
    """Mock Discord EmbedField class."""

    def __init__(self, name: str = "", value: str = "", inline: bool = False) -> None:
        self.name = name
        self.value = value
        self.inline = inline


class MockEmbed:
    """Mock Discord Embed class."""

    def __init__(self) -> None:
        self.title: str | None = None
        self.description: str | None = None
        self.url: str | None = None
        self.timestamp = None
        self.color: MockColor | None = None
        self.footer: MockEmbedFooter | None = None
        self.image: MockEmbedMedia | None = None
        self.thumbnail: MockEmbedMedia | None = None
        self.author: MockEmbedAuthor | None = None
        self.fields: list[MockEmbedField] = []


class MockMessage:
    """Mock Discord Message class."""

    def __init__(self) -> None:
        self.id = 987654321
        self.content = "Test message"
        self.author = MockUser()
        self.channel = MockTextChannel()
        self.guild: MockGuild | None = MockGuild()
        self.created_at = MagicMock()
        self.created_at.isoformat = MagicMock(return_value="2024-01-01T00:00:00")
        self.attachments: list[MockAttachment] = []
        self.embeds: list[MockEmbed] = []
        self.mentions: list[MockUser] = []

    async def reply(self, content: str) -> MockMessage:
        msg = MockMessage()
        msg.content = content
        return msg

    async def add_reaction(self, emoji: str) -> None:
        pass


class MockTextChannel:
    """Mock Discord TextChannel class."""

    def __init__(self, channel_id: int = 111222333, name: str = "test-channel") -> None:
        self.id = channel_id
        self.name = name

    async def send(self, content: str) -> MockMessage:
        msg = MockMessage()
        msg.content = content
        return msg

    async def fetch_message(self, message_id: int) -> MockMessage:
        msg = MockMessage()
        msg.id = message_id
        return msg


class MockDMChannel:
    """Mock Discord DMChannel class."""

    def __init__(self, channel_id: int = 444555666) -> None:
        self.id = channel_id

    async def send(self, content: str) -> MockMessage:
        msg = MockMessage()
        msg.content = content
        return msg

    async def fetch_message(self, message_id: int) -> MockMessage:
        msg = MockMessage()
        msg.id = message_id
        return msg


class MockThread:
    """Mock Discord Thread class."""

    def __init__(self, thread_id: int = 777888999, name: str = "test-thread") -> None:
        self.id = thread_id
        self.name = name

    async def send(self, content: str) -> MockMessage:
        msg = MockMessage()
        msg.content = content
        return msg

    async def fetch_message(self, message_id: int) -> MockMessage:
        msg = MockMessage()
        msg.id = message_id
        return msg


class MockVoiceChannel:
    """Mock Discord VoiceChannel class."""

    def __init__(self, channel_id: int = 333444555, name: str = "test-voice") -> None:
        self.id = channel_id
        self.name = name


class MockStageChannel:
    """Mock Discord StageChannel class."""

    def __init__(self, channel_id: int = 666777888, name: str = "test-stage") -> None:
        self.id = channel_id
        self.name = name


class MockVoiceState:
    """Mock Discord VoiceState class."""

    def __init__(self) -> None:
        self.channel: MockVoiceChannel | None = None
        self.session_id: str | None = "test-session"
        self.mute = False
        self.deaf = False
        self.self_mute = False
        self.self_deaf = False
        self.self_stream: bool | None = False
        self.self_video = False


class MockEmoji:
    """Mock Discord Emoji class."""

    def __init__(self, emoji: str = "👍") -> None:
        self._emoji = emoji
        self.id: int | None = None

    def is_custom_emoji(self) -> bool:
        return self.id is not None

    def __str__(self) -> str:
        return self._emoji


class MockRawReactionActionEvent:
    """Mock Discord RawReactionActionEvent class."""

    def __init__(self) -> None:
        self.user_id = 123456789
        self.channel_id = 111222333
        self.message_id = 987654321
        self.guild_id: int | None = 555666777
        self.emoji = MockEmoji()


class MockGuild:
    """Mock Discord Guild class."""

    def __init__(self, guild_id: int = 555666777, name: str = "Test Guild") -> None:
        self.id = guild_id
        self.name = name
        self.member_count = 100
        self.channels: list[MockTextChannel | MockVoiceChannel | MockStageChannel] = [
            MockTextChannel(),
            MockVoiceChannel(),
        ]


class MockClient:
    """Mock Discord Client class."""

    def __init__(self, intents: MockIntents | None = None) -> None:
        self.intents = intents or MockIntents.default()
        self.user: MockUser | None = None
        self.guilds: list[MockGuild] = []
        self._event_handlers: dict[str, Callable[..., Coroutine[None, None, None]]] = {}

    def event(
        self, func: Callable[..., Coroutine[None, None, None]]
    ) -> Callable[..., Coroutine[None, None, None]]:
        self._event_handlers[func.__name__] = func
        return func

    async def start(self, _token: str) -> None:
        self.user = MockUser(name="TestBot", bot=True)
        self.guilds = [MockGuild()]

    async def close(self) -> None:
        pass

    def get_channel(self, channel_id: int) -> MockTextChannel | None:
        return MockTextChannel(channel_id=channel_id)

    async def fetch_channel(self, channel_id: int) -> MockTextChannel:
        return MockTextChannel(channel_id=channel_id)

    def get_user(self, user_id: int) -> MockUser | None:
        return MockUser(user_id=user_id)

    async def fetch_user(self, user_id: int) -> MockUser:
        return MockUser(user_id=user_id)

    def get_guild(self, guild_id: int) -> MockGuild | None:
        return MockGuild(guild_id=guild_id)

    async def fetch_guild(self, guild_id: int) -> MockGuild:
        return MockGuild(guild_id=guild_id)


class MockLoginFailure(Exception):
    """Mock Discord LoginFailure exception."""

    pass


# =============================================================================
# Install mock discord module IMMEDIATELY
# This MUST happen before pytest imports test modules for collection
# =============================================================================

mock_discord = MagicMock()
mock_discord.Client = MockClient
mock_discord.Intents = MockIntents
mock_discord.Member = MockMember
mock_discord.Message = MockMessage
mock_discord.VoiceState = MockVoiceState
mock_discord.RawReactionActionEvent = MockRawReactionActionEvent
mock_discord.TextChannel = MockTextChannel
mock_discord.DMChannel = MockDMChannel
mock_discord.Thread = MockThread
mock_discord.VoiceChannel = MockVoiceChannel
mock_discord.StageChannel = MockStageChannel
mock_discord.LoginFailure = MockLoginFailure
mock_discord.User = MockUser
mock_discord.Guild = MockGuild
mock_discord.Embed = MockEmbed
mock_discord.Color = MockColor
mock_discord.Attachment = MockAttachment

# Install the mock into sys.modules BEFORE pytest is imported
sys.modules["discord"] = mock_discord


# =============================================================================
# Now safe to import pytest and define fixtures
# =============================================================================

import pytest  # noqa: E402

if TYPE_CHECKING:
    from elizaos_plugin_discord import DiscordService


@pytest.fixture
def mock_client() -> MockClient:
    """Provide a mock Discord client instance."""
    return MockClient()


@pytest.fixture
def mock_message() -> MockMessage:
    """Provide a mock Discord message instance."""
    return MockMessage()


@pytest.fixture
def mock_guild() -> MockGuild:
    """Provide a mock Discord guild instance."""
    return MockGuild()


@pytest.fixture
def discord_config() -> dict[str, str | bool | list[str] | None]:
    """Provide a test configuration for Discord service."""
    return {
        "token": "test-token-12345",
        "application_id": "123456789",
        "should_ignore_bot_messages": True,
        "should_ignore_direct_messages": False,
        "should_respond_only_to_mentions": False,
        "channel_ids": None,
    }


@pytest.fixture
async def discord_service() -> AsyncIterator[DiscordService]:
    """Provide a Discord service instance for testing."""
    from elizaos_plugin_discord import DiscordConfig, DiscordService

    config = DiscordConfig(
        token="test-token-12345",
        application_id="123456789",
    )
    service = DiscordService(config)
    yield service
    if service.is_running:
        await service.stop()
