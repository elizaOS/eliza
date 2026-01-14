"""
Type definitions for the Discord plugin.

Strong types with validation - no Any types allowed.
"""

from enum import Enum

from pydantic import BaseModel, ConfigDict, field_validator


class Snowflake(str):
    """
    Discord snowflake ID.

    A validated Discord snowflake - always 17-19 digits.
    """

    def __new__(cls, value: str) -> "Snowflake":
        """Create a new snowflake with validation."""
        cls._validate(value)
        return super().__new__(cls, value)

    @staticmethod
    def _validate(value: str) -> None:
        """Validate a snowflake string."""
        from elizaos_plugin_discord.error import InvalidSnowflakeError

        if not value:
            raise InvalidSnowflakeError("Snowflake cannot be empty")

        if len(value) < 17 or len(value) > 19:
            raise InvalidSnowflakeError(f"Snowflake must be 17-19 characters, got {len(value)}")

        if not value.isdigit():
            raise InvalidSnowflakeError("Snowflake must contain only digits")

    def as_int(self) -> int:
        """Convert to integer."""
        return int(self)


class DiscordEventType(str, Enum):
    """Discord event types."""

    MESSAGE_RECEIVED = "MESSAGE_RECEIVED"
    MESSAGE_SENT = "MESSAGE_SENT"
    SLASH_COMMAND = "SLASH_COMMAND"
    MODAL_SUBMIT = "MODAL_SUBMIT"
    REACTION_RECEIVED = "REACTION_RECEIVED"
    REACTION_REMOVED = "REACTION_REMOVED"
    WORLD_JOINED = "WORLD_JOINED"
    WORLD_CONNECTED = "WORLD_CONNECTED"
    ENTITY_JOINED = "ENTITY_JOINED"
    ENTITY_LEFT = "ENTITY_LEFT"
    VOICE_STATE_CHANGED = "VOICE_STATE_CHANGED"
    CHANNEL_PERMISSIONS_CHANGED = "CHANNEL_PERMISSIONS_CHANGED"
    ROLE_PERMISSIONS_CHANGED = "ROLE_PERMISSIONS_CHANGED"
    MEMBER_ROLES_CHANGED = "MEMBER_ROLES_CHANGED"
    ROLE_CREATED = "ROLE_CREATED"
    ROLE_DELETED = "ROLE_DELETED"


class DiscordChannelType(str, Enum):
    """Discord channel types."""

    TEXT = "TEXT"
    DM = "DM"
    VOICE = "VOICE"
    GROUP_DM = "GROUP_DM"
    CATEGORY = "CATEGORY"
    ANNOUNCEMENT = "ANNOUNCEMENT"
    THREAD = "THREAD"
    STAGE = "STAGE"
    FORUM = "FORUM"


class DiscordAttachment(BaseModel):
    """Discord attachment."""

    model_config = ConfigDict(frozen=True)

    id: str
    filename: str
    size: int
    url: str
    proxy_url: str
    content_type: str | None = None
    height: int | None = None
    width: int | None = None

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        Snowflake(v)  # Validate as snowflake
        return v


class DiscordEmbedFooter(BaseModel):
    """Discord embed footer."""

    model_config = ConfigDict(frozen=True)

    text: str
    icon_url: str | None = None


class DiscordEmbedMedia(BaseModel):
    """Discord embed media (image/thumbnail/video)."""

    model_config = ConfigDict(frozen=True)

    url: str
    proxy_url: str | None = None
    height: int | None = None
    width: int | None = None


class DiscordEmbedAuthor(BaseModel):
    """Discord embed author."""

    model_config = ConfigDict(frozen=True)

    name: str
    url: str | None = None
    icon_url: str | None = None


class DiscordEmbedField(BaseModel):
    """Discord embed field."""

    model_config = ConfigDict(frozen=True)

    name: str
    value: str
    inline: bool = False


class DiscordEmbed(BaseModel):
    """Discord embed."""

    model_config = ConfigDict(frozen=True)

    title: str | None = None
    description: str | None = None
    url: str | None = None
    timestamp: str | None = None
    color: int | None = None
    footer: DiscordEmbedFooter | None = None
    image: DiscordEmbedMedia | None = None
    thumbnail: DiscordEmbedMedia | None = None
    author: DiscordEmbedAuthor | None = None
    fields: list[DiscordEmbedField] = []


class DiscordMessagePayload(BaseModel):
    """Message payload for Discord events."""

    model_config = ConfigDict(frozen=True)

    message_id: str
    channel_id: str
    guild_id: str | None = None
    author_id: str
    author_name: str
    content: str
    timestamp: str
    is_bot: bool
    attachments: list[DiscordAttachment] = []
    embeds: list[DiscordEmbed] = []
    mentions: list[str] = []

    @field_validator("message_id", "channel_id", "author_id")
    @classmethod
    def validate_snowflakes(cls, v: str) -> str:
        Snowflake(v)  # Validate as snowflake
        return v

    @field_validator("guild_id")
    @classmethod
    def validate_optional_snowflake(cls, v: str | None) -> str | None:
        if v is not None:
            Snowflake(v)  # Validate as snowflake
        return v


class DiscordReactionPayload(BaseModel):
    """Reaction payload."""

    model_config = ConfigDict(frozen=True)

    user_id: str
    channel_id: str
    message_id: str
    guild_id: str | None = None
    emoji: str
    is_custom_emoji: bool
    emoji_id: str | None = None

    @field_validator("user_id", "channel_id", "message_id")
    @classmethod
    def validate_snowflakes(cls, v: str) -> str:
        Snowflake(v)
        return v


class DiscordVoiceStatePayload(BaseModel):
    """Voice state payload."""

    model_config = ConfigDict(frozen=True)

    user_id: str
    guild_id: str
    channel_id: str | None = None
    session_id: str
    is_muted: bool
    is_deafened: bool
    is_self_muted: bool
    is_self_deafened: bool
    is_streaming: bool
    is_video_on: bool

    @field_validator("user_id", "guild_id")
    @classmethod
    def validate_snowflakes(cls, v: str) -> str:
        Snowflake(v)
        return v


class DiscordChannelInfo(BaseModel):
    """Basic channel information."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    channel_type: DiscordChannelType

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        Snowflake(v)
        return v


class DiscordWorldPayload(BaseModel):
    """Guild/world joined payload."""

    model_config = ConfigDict(frozen=True)

    guild_id: str
    guild_name: str
    member_count: int
    created_at: str | None = None
    owner_id: str | None = None
    owner_name: str | None = None
    description: str | None = None
    role_count: int | None = None
    channel_count: int | None = None
    premium_tier: int | None = None
    premium_subscription_count: int | None = None
    text_channels: list[DiscordChannelInfo] = []
    voice_channels: list[DiscordChannelInfo] = []

    @field_validator("guild_id")
    @classmethod
    def validate_guild_id(cls, v: str) -> str:
        Snowflake(v)
        return v

    @field_validator("owner_id")
    @classmethod
    def validate_owner_id(cls, v: str | None) -> str | None:
        if v is not None:
            Snowflake(v)
        return v


class DiscordMemberPayload(BaseModel):
    """Member joined/left payload."""

    model_config = ConfigDict(frozen=True)

    user_id: str
    username: str
    display_name: str | None = None
    guild_id: str
    roles: list[str] = []
    joined_at: str | None = None

    @field_validator("user_id", "guild_id")
    @classmethod
    def validate_snowflakes(cls, v: str) -> str:
        Snowflake(v)
        return v


class DiscordSettings(BaseModel):
    """Discord settings for a channel/guild."""

    model_config = ConfigDict(frozen=True)

    allowed_channel_ids: list[str] = []
    should_ignore_bot_messages: bool = True
    should_ignore_direct_messages: bool = False
    should_respond_only_to_mentions: bool = False
