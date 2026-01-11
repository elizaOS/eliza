"""
Discord service implementation.

Provides the main DiscordService for connecting to Discord and handling events.
"""

import logging
from collections.abc import Awaitable, Callable

import discord
from discord import Intents, Member, Message, RawReactionActionEvent, VoiceState

from elizaos_plugin_discord.config import DiscordConfig
from elizaos_plugin_discord.error import (
    AlreadyRunningError,
    ClientNotInitializedError,
    ConnectionFailedError,
    InvalidArgumentError,
)
from elizaos_plugin_discord.types import (
    DiscordAttachment,
    DiscordChannelInfo,
    DiscordChannelType,
    DiscordEmbed,
    DiscordEmbedAuthor,
    DiscordEmbedField,
    DiscordEmbedFooter,
    DiscordEmbedMedia,
    DiscordEventType,
    DiscordMemberPayload,
    DiscordMessagePayload,
    DiscordReactionPayload,
    DiscordVoiceStatePayload,
    DiscordWorldPayload,
    Snowflake,
)

logger = logging.getLogger(__name__)

# Maximum message length for Discord
MAX_MESSAGE_LENGTH = 2000

# Type alias for event callbacks
EventCallback = Callable[[DiscordEventType, dict], Awaitable[None]]
MessageCallback = Callable[[DiscordMessagePayload], Awaitable[None]]


class DiscordService:
    """
    Discord service for elizaOS.

    Manages connection to Discord and handles all Discord operations.
    """

    def __init__(self, config: DiscordConfig) -> None:
        """
        Create a new Discord service.

        Args:
            config: Discord configuration.
        """
        self._config = config
        self._client: discord.Client | None = None
        self._is_running = False
        self._event_callbacks: list[EventCallback] = []
        self._message_callbacks: list[MessageCallback] = []

    @property
    def config(self) -> DiscordConfig:
        """Get the configuration."""
        return self._config

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._is_running

    def on_event(self, callback: EventCallback) -> EventCallback:
        """
        Register an event callback (decorator).

        Args:
            callback: Async function to call when events occur.

        Returns:
            The callback (for use as decorator).
        """
        self._event_callbacks.append(callback)
        return callback

    def on_message(self, callback: MessageCallback) -> MessageCallback:
        """
        Register a message callback (decorator).

        Args:
            callback: Async function to call when messages are received.

        Returns:
            The callback (for use as decorator).
        """
        self._message_callbacks.append(callback)
        return callback

    async def _emit_event(
        self, event_type: DiscordEventType, payload: dict
    ) -> None:
        """Emit an event to all registered callbacks."""
        for callback in self._event_callbacks:
            try:
                await callback(event_type, payload)
            except Exception as e:
                logger.error(f"Error in event callback: {e}")

    async def _emit_message(self, payload: DiscordMessagePayload) -> None:
        """Emit a message to all registered callbacks."""
        for callback in self._message_callbacks:
            try:
                await callback(payload)
            except Exception as e:
                logger.error(f"Error in message callback: {e}")

    async def start(self) -> None:
        """
        Start the Discord service.

        Raises:
            AlreadyRunningError: If service is already running.
            ConnectionFailedError: If connection to Discord fails.
        """
        if self._is_running:
            raise AlreadyRunningError()

        logger.info("Starting Discord service...")

        # Set up intents
        intents = Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.guild_messages = True
        intents.dm_messages = True
        intents.guild_voice_states = True
        intents.guild_reactions = True
        intents.members = True

        # Create client
        self._client = discord.Client(intents=intents)

        # Set up event handlers
        self._setup_event_handlers()

        # Start client
        self._is_running = True

        try:
            await self._client.start(self._config.token)
        except discord.LoginFailure as e:
            self._is_running = False
            raise ConnectionFailedError(str(e))
        except Exception as e:
            self._is_running = False
            raise ConnectionFailedError(str(e))

    async def stop(self) -> None:
        """Stop the Discord service."""
        logger.info("Stopping Discord service...")

        if self._client is not None:
            await self._client.close()
            self._client = None

        self._is_running = False
        logger.info("Discord service stopped")

    def _setup_event_handlers(self) -> None:
        """Set up Discord event handlers."""
        if self._client is None:
            return

        @self._client.event
        async def on_ready() -> None:
            if self._client is None or self._client.user is None:
                return

            logger.info(
                f"Discord bot connected as {self._client.user.name}#{self._client.user.discriminator}"
            )

            await self._emit_event(
                DiscordEventType.WORLD_CONNECTED,
                {
                    "bot_id": str(self._client.user.id),
                    "bot_name": self._client.user.name,
                    "guilds": len(self._client.guilds),
                },
            )

        @self._client.event
        async def on_message(message: Message) -> None:
            if self._client is None or self._client.user is None:
                return

            # Skip messages from self
            if message.author.id == self._client.user.id:
                return

            # Skip bot messages if configured
            if message.author.bot and self._config.should_ignore_bot_messages:
                logger.debug(f"Ignoring bot message from {message.author.name}")
                return

            # Skip DMs if configured
            if message.guild is None and self._config.should_ignore_direct_messages:
                logger.debug(f"Ignoring DM from {message.author.name}")
                return

            # Check channel allowlist
            if self._config.channel_ids:
                channel_id_str = str(message.channel.id)
                if channel_id_str not in self._config.channel_ids:
                    logger.debug(f"Ignoring message in non-allowed channel {channel_id_str}")
                    return

            # Check if bot is mentioned (if respond only to mentions)
            if self._config.should_respond_only_to_mentions:
                if self._client.user not in message.mentions:
                    logger.debug("Ignoring message without bot mention")
                    return

            # Build payload
            payload = DiscordMessagePayload(
                message_id=str(message.id),
                channel_id=str(message.channel.id),
                guild_id=str(message.guild.id) if message.guild else None,
                author_id=str(message.author.id),
                author_name=message.author.name,
                content=message.content,
                timestamp=message.created_at.isoformat(),
                is_bot=message.author.bot,
                attachments=[
                    DiscordAttachment(
                        id=str(a.id),
                        filename=a.filename,
                        size=a.size,
                        url=a.url,
                        proxy_url=a.proxy_url,
                        content_type=a.content_type,
                        height=a.height,
                        width=a.width,
                    )
                    for a in message.attachments
                ],
                embeds=[
                    DiscordEmbed(
                        title=e.title,
                        description=e.description,
                        url=e.url,
                        timestamp=e.timestamp.isoformat() if e.timestamp else None,
                        color=e.color.value if e.color else None,
                        footer=(
                            DiscordEmbedFooter(
                                text=e.footer.text,
                                icon_url=e.footer.icon_url,
                            )
                            if e.footer and e.footer.text
                            else None
                        ),
                        image=(
                            DiscordEmbedMedia(
                                url=e.image.url,
                                proxy_url=e.image.proxy_url,
                                height=e.image.height,
                                width=e.image.width,
                            )
                            if e.image
                            else None
                        ),
                        thumbnail=(
                            DiscordEmbedMedia(
                                url=e.thumbnail.url,
                                proxy_url=e.thumbnail.proxy_url,
                                height=e.thumbnail.height,
                                width=e.thumbnail.width,
                            )
                            if e.thumbnail
                            else None
                        ),
                        author=(
                            DiscordEmbedAuthor(
                                name=e.author.name,
                                url=e.author.url,
                                icon_url=e.author.icon_url,
                            )
                            if e.author and e.author.name
                            else None
                        ),
                        fields=[
                            DiscordEmbedField(
                                name=f.name,
                                value=f.value,
                                inline=f.inline,
                            )
                            for f in e.fields
                        ],
                    )
                    for e in message.embeds
                ],
                mentions=[str(u.id) for u in message.mentions],
            )

            await self._emit_event(
                DiscordEventType.MESSAGE_RECEIVED,
                payload.model_dump(),
            )
            await self._emit_message(payload)

        @self._client.event
        async def on_member_join(member: Member) -> None:
            payload = DiscordMemberPayload(
                user_id=str(member.id),
                username=member.name,
                display_name=member.display_name,
                guild_id=str(member.guild.id),
                roles=[str(r.id) for r in member.roles],
                joined_at=member.joined_at.isoformat() if member.joined_at else None,
            )

            await self._emit_event(
                DiscordEventType.ENTITY_JOINED,
                payload.model_dump(),
            )

        @self._client.event
        async def on_member_remove(member: Member) -> None:
            payload = DiscordMemberPayload(
                user_id=str(member.id),
                username=member.name,
                display_name=member.display_name,
                guild_id=str(member.guild.id),
                roles=[],
                joined_at=None,
            )

            await self._emit_event(
                DiscordEventType.ENTITY_LEFT,
                payload.model_dump(),
            )

        @self._client.event
        async def on_voice_state_update(
            member: Member,
            before: VoiceState,
            after: VoiceState,
        ) -> None:
            payload = DiscordVoiceStatePayload(
                user_id=str(member.id),
                guild_id=str(member.guild.id),
                channel_id=str(after.channel.id) if after.channel else None,
                session_id=after.session_id or "",
                is_muted=after.mute,
                is_deafened=after.deaf,
                is_self_muted=after.self_mute,
                is_self_deafened=after.self_deaf,
                is_streaming=after.self_stream or False,
                is_video_on=after.self_video,
            )

            await self._emit_event(
                DiscordEventType.VOICE_STATE_CHANGED,
                payload.model_dump(),
            )

        @self._client.event
        async def on_raw_reaction_add(payload: RawReactionActionEvent) -> None:
            reaction_payload = DiscordReactionPayload(
                user_id=str(payload.user_id),
                channel_id=str(payload.channel_id),
                message_id=str(payload.message_id),
                guild_id=str(payload.guild_id) if payload.guild_id else None,
                emoji=str(payload.emoji),
                is_custom_emoji=payload.emoji.is_custom_emoji(),
                emoji_id=str(payload.emoji.id) if payload.emoji.id else None,
            )

            await self._emit_event(
                DiscordEventType.REACTION_RECEIVED,
                reaction_payload.model_dump(),
            )

        @self._client.event
        async def on_raw_reaction_remove(payload: RawReactionActionEvent) -> None:
            reaction_payload = DiscordReactionPayload(
                user_id=str(payload.user_id),
                channel_id=str(payload.channel_id),
                message_id=str(payload.message_id),
                guild_id=str(payload.guild_id) if payload.guild_id else None,
                emoji=str(payload.emoji),
                is_custom_emoji=payload.emoji.is_custom_emoji(),
                emoji_id=str(payload.emoji.id) if payload.emoji.id else None,
            )

            await self._emit_event(
                DiscordEventType.REACTION_REMOVED,
                reaction_payload.model_dump(),
            )

    async def send_message(
        self,
        channel_id: str,
        content: str,
    ) -> Snowflake:
        """
        Send a message to a channel.

        Args:
            channel_id: The channel ID to send to.
            content: The message content.

        Returns:
            The ID of the sent message.

        Raises:
            ClientNotInitializedError: If client is not initialized.
            InvalidArgumentError: If arguments are invalid.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(channel_id)
        channel = self._client.get_channel(snowflake.as_int())

        if channel is None:
            channel = await self._client.fetch_channel(snowflake.as_int())

        if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
            raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

        # Split message if too long
        parts = split_message(content)

        last_message: discord.Message | None = None
        for part in parts:
            last_message = await channel.send(part)

        if last_message is None:
            raise InvalidArgumentError("No message content provided")

        return Snowflake(str(last_message.id))

    async def send_dm(
        self,
        user_id: str,
        content: str,
    ) -> Snowflake:
        """
        Send a direct message to a user.

        Args:
            user_id: The user ID to send to.
            content: The message content.

        Returns:
            The ID of the sent message.

        Raises:
            ClientNotInitializedError: If client is not initialized.
            InvalidArgumentError: If arguments are invalid.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(user_id)
        user = self._client.get_user(snowflake.as_int())

        if user is None:
            user = await self._client.fetch_user(snowflake.as_int())

        # Split message if too long
        parts = split_message(content)

        last_message: discord.Message | None = None
        for part in parts:
            last_message = await user.send(part)

        if last_message is None:
            raise InvalidArgumentError("No message content provided")

        return Snowflake(str(last_message.id))

    async def reply_to_message(
        self,
        channel_id: str,
        message_id: str,
        content: str,
    ) -> Snowflake:
        """
        Reply to a message.

        Args:
            channel_id: The channel ID.
            message_id: The message ID to reply to.
            content: The reply content.

        Returns:
            The ID of the sent message.

        Raises:
            ClientNotInitializedError: If client is not initialized.
            InvalidArgumentError: If arguments are invalid.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        channel_snowflake = Snowflake(channel_id)
        message_snowflake = Snowflake(message_id)

        channel = self._client.get_channel(channel_snowflake.as_int())
        if channel is None:
            channel = await self._client.fetch_channel(channel_snowflake.as_int())

        if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
            raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

        message = await channel.fetch_message(message_snowflake.as_int())

        # Split message if too long
        parts = split_message(content)

        last_message: discord.Message | None = None
        for i, part in enumerate(parts):
            if i == 0:
                last_message = await message.reply(part)
            else:
                last_message = await channel.send(part)

        if last_message is None:
            raise InvalidArgumentError("No message content provided")

        return Snowflake(str(last_message.id))

    async def add_reaction(
        self,
        channel_id: str,
        message_id: str,
        emoji: str,
    ) -> None:
        """
        Add a reaction to a message.

        Args:
            channel_id: The channel ID.
            message_id: The message ID to react to.
            emoji: The emoji to react with.

        Raises:
            ClientNotInitializedError: If client is not initialized.
            InvalidArgumentError: If arguments are invalid.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        channel_snowflake = Snowflake(channel_id)
        message_snowflake = Snowflake(message_id)

        channel = self._client.get_channel(channel_snowflake.as_int())
        if channel is None:
            channel = await self._client.fetch_channel(channel_snowflake.as_int())

        if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
            raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

        message = await channel.fetch_message(message_snowflake.as_int())
        await message.add_reaction(emoji)

    async def get_guild_info(self, guild_id: str) -> DiscordWorldPayload:
        """
        Get guild information.

        Args:
            guild_id: The guild ID.

        Returns:
            Guild information payload.

        Raises:
            ClientNotInitializedError: If client is not initialized.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(guild_id)
        guild = self._client.get_guild(snowflake.as_int())

        if guild is None:
            guild = await self._client.fetch_guild(snowflake.as_int())

        text_channels: list[DiscordChannelInfo] = []
        voice_channels: list[DiscordChannelInfo] = []

        for channel in guild.channels:
            channel_type: DiscordChannelType
            if isinstance(channel, discord.TextChannel):
                channel_type = DiscordChannelType.TEXT
                text_channels.append(
                    DiscordChannelInfo(
                        id=str(channel.id),
                        name=channel.name,
                        channel_type=channel_type,
                    )
                )
            elif isinstance(channel, discord.VoiceChannel):
                channel_type = DiscordChannelType.VOICE
                voice_channels.append(
                    DiscordChannelInfo(
                        id=str(channel.id),
                        name=channel.name,
                        channel_type=channel_type,
                    )
                )
            elif isinstance(channel, discord.StageChannel):
                channel_type = DiscordChannelType.STAGE
                voice_channels.append(
                    DiscordChannelInfo(
                        id=str(channel.id),
                        name=channel.name,
                        channel_type=channel_type,
                    )
                )

        return DiscordWorldPayload(
            guild_id=str(guild.id),
            guild_name=guild.name,
            member_count=guild.member_count or 0,
            text_channels=text_channels,
            voice_channels=voice_channels,
        )


def split_message(content: str) -> list[str]:
    """
    Split a message into chunks that fit within Discord's limit.

    Args:
        content: The message content to split.

    Returns:
        List of message parts.
    """
    if len(content) <= MAX_MESSAGE_LENGTH:
        return [content]

    parts: list[str] = []
    current = ""

    for line in content.splitlines(keepends=True):
        # Check if adding this line would exceed limit
        if len(current) + len(line) > MAX_MESSAGE_LENGTH:
            # If current is not empty, push it
            if current:
                parts.append(current)
                current = ""

            # If the line itself is too long, split by words
            if len(line) > MAX_MESSAGE_LENGTH:
                words = line.split()
                for word in words:
                    word_with_space = f" {word}" if current else word

                    if len(current) + len(word_with_space) > MAX_MESSAGE_LENGTH:
                        if current:
                            parts.append(current)
                            current = ""

                        # If single word is too long, split by characters
                        if len(word) > MAX_MESSAGE_LENGTH:
                            for i in range(0, len(word), MAX_MESSAGE_LENGTH):
                                parts.append(word[i : i + MAX_MESSAGE_LENGTH])
                        else:
                            current = word
                    else:
                        current += word_with_space
            else:
                current = line
        else:
            current += line

    # Don't forget the last part
    if current:
        parts.append(current)

    return parts


