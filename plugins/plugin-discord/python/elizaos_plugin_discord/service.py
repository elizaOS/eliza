import logging
import re
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypedDict

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

MAX_MESSAGE_LENGTH = 2000

EventCallback = Callable[[DiscordEventType, dict[str, object]], Awaitable[None]]
MessageCallback = Callable[[DiscordMessagePayload], Awaitable[None]]


class DiscordUserSummary(TypedDict):
    id: str
    username: str


class DiscordMessageSummary(TypedDict):
    id: str
    content: str
    pinned: bool
    author: DiscordUserSummary
    timestamp: str


class ChannelInfoSummary(TypedDict):
    id: str
    name: str
    server: str
    mention: str


class ReactionInfo(TypedDict):
    emoji: str
    message_ref: str


class PollInfo(TypedDict):
    question: str
    options: list[str]
    use_emojis: bool


class DownloadedMedia(TypedDict):
    path: str
    filename: str
    content_type: str | None


class DiscordService:
    def __init__(self, config: DiscordConfig) -> None:
        self._config = config
        self._client: discord.Client | None = None
        self._is_running = False
        self._event_callbacks: list[EventCallback] = []
        self._message_callbacks: list[MessageCallback] = []
        self._env_channel_ids: set[str] = set(config.channel_ids)
        self._allowed_channel_ids: set[str] = set(config.channel_ids)

    @property
    def config(self) -> DiscordConfig:
        return self._config

    @property
    def is_running(self) -> bool:
        return self._is_running

    def on_event(self, callback: EventCallback) -> EventCallback:
        self._event_callbacks.append(callback)
        return callback

    def on_message(self, callback: MessageCallback) -> MessageCallback:
        self._message_callbacks.append(callback)
        return callback

    async def _emit_event(self, event_type: DiscordEventType, payload: dict[str, object]) -> None:
        for callback in self._event_callbacks:
            try:
                await callback(event_type, payload)
            except Exception as e:
                logger.error(f"Error in event callback: {e}")

    async def _emit_message(self, payload: DiscordMessagePayload) -> None:
        for callback in self._message_callbacks:
            try:
                await callback(payload)
            except Exception as e:
                logger.error(f"Error in message callback: {e}")

    async def start(self) -> None:
        if self._is_running:
            raise AlreadyRunningError()

        logger.info("Starting Discord service...")

        intents = Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.guild_messages = True
        intents.dm_messages = True
        intents.guild_voice_states = True
        intents.guild_reactions = True
        intents.members = True

        self._client = discord.Client(intents=intents)

        self._setup_event_handlers()

        self._is_running = True

        try:
            await self._client.start(self._config.token)
        except discord.LoginFailure as e:
            self._is_running = False
            raise ConnectionFailedError(str(e)) from e
        except Exception as e:
            self._is_running = False
            raise ConnectionFailedError(str(e)) from e

    async def stop(self) -> None:
        logger.info("Stopping Discord service...")

        if self._client is not None:
            await self._client.close()
            self._client = None

        self._is_running = False
        logger.info("Discord service stopped")

    def _setup_event_handlers(self) -> None:
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

            if message.author.id == self._client.user.id:
                return

            if message.author.bot and self._config.should_ignore_bot_messages:
                logger.debug(f"Ignoring bot message from {message.author.name}")
                return

            if message.guild is None and self._config.should_ignore_direct_messages:
                logger.debug(f"Ignoring DM from {message.author.name}")
                return

            channel_id_str = str(message.channel.id)
            if not self.is_channel_allowed(channel_id_str):
                logger.debug(f"Ignoring message in non-allowed channel {channel_id_str}")
                return

            if (
                self._config.should_respond_only_to_mentions
                and self._client.user not in message.mentions
            ):
                logger.debug("Ignoring message without bot mention")
                return

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
            _before: VoiceState,
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
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(channel_id)
        channel = self._client.get_channel(snowflake.as_int())

        if channel is None:
            channel = await self._client.fetch_channel(snowflake.as_int())

        if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
            raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

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
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(user_id)
        user = self._client.get_user(snowflake.as_int())

        if user is None:
            user = await self._client.fetch_user(snowflake.as_int())

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
    ) -> bool:
        if self._client is None:
            raise ClientNotInitializedError()

        try:
            channel_snowflake = Snowflake(channel_id)
            message_snowflake = Snowflake(message_id)

            channel = self._client.get_channel(channel_snowflake.as_int())
            if channel is None:
                channel = await self._client.fetch_channel(channel_snowflake.as_int())

            if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
                raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

            message = await channel.fetch_message(message_snowflake.as_int())
            await message.add_reaction(emoji)
            return True
        except Exception:
            return False

    async def get_guild_info(self, guild_id: str) -> DiscordWorldPayload:
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
            created_at=guild.created_at.isoformat() if getattr(guild, "created_at", None) else None,
            owner_id=str(guild.owner_id) if getattr(guild, "owner_id", None) else None,
            owner_name=(
                guild.owner.name
                if getattr(guild, "owner", None) is not None and getattr(guild.owner, "name", None)
                else None
            ),
            description=getattr(guild, "description", None),
            role_count=len(getattr(guild, "roles", [])),
            channel_count=len(getattr(guild, "channels", [])),
            premium_tier=(
                int(getattr(guild, "premium_tier", 0))
                if getattr(guild, "premium_tier", None) is not None
                else None
            ),
            premium_subscription_count=getattr(guild, "premium_subscription_count", None),
            text_channels=text_channels,
            voice_channels=voice_channels,
        )

    # ---------------------------------------------------------------------
    # Channel allowlist helpers (runtime mutable)
    # ---------------------------------------------------------------------

    def get_allowed_channels(self) -> list[str]:
        """Get the currently configured allowed channel IDs.

        Note: An empty list means "unrestricted" (listen in all channels).
        """
        return sorted(self._allowed_channel_ids)

    def has_env_channels(self) -> bool:
        """Whether any channels are configured via environment/settings."""
        return bool(self._env_channel_ids)

    def is_env_channel(self, channel_id: str) -> bool:
        return channel_id in self._env_channel_ids

    def is_channel_allowed(self, channel_id: str) -> bool:
        # Empty allowlist means unrestricted.
        if not self._allowed_channel_ids:
            return True
        return channel_id in self._allowed_channel_ids

    async def add_allowed_channel(self, channel_id: str) -> bool:
        """Add a channel to the allowlist.

        Returns True if the channel is (or is now) allowed.
        """
        Snowflake(channel_id)

        if not self._allowed_channel_ids:
            # Unrestricted mode: already allowed.
            return False

        self._allowed_channel_ids.add(channel_id)
        return True

    async def remove_allowed_channel(self, channel_id: str) -> bool:
        """Remove a channel from the allowlist.

        Returns True if removed.
        """
        Snowflake(channel_id)

        if self.is_env_channel(channel_id):
            return False

        if not self._allowed_channel_ids:
            # Unrestricted mode cannot "remove" a channel without switching to a blocklist model.
            return False

        if channel_id not in self._allowed_channel_ids:
            return False

        self._allowed_channel_ids.remove(channel_id)
        return True

    # ---------------------------------------------------------------------
    # Parsing helpers
    # ---------------------------------------------------------------------

    async def extract_channel_id(self, text: str) -> str | None:
        """Extract a channel snowflake from user text."""
        if not text:
            return None

        mention_match = re.search(r"<#(\d{17,19})>", text)
        if mention_match:
            return mention_match.group(1)

        id_match = re.search(r"\b(\d{17,19})\b", text)
        if id_match:
            return id_match.group(1)

        return None

    async def extract_message_limit(self, text: str) -> int:
        """Extract a requested message limit from text (default 20)."""
        default_limit = 20
        if not text:
            return default_limit

        match = re.search(r"\b(?:last|recent|past)\s+(\d{1,3})\b", text, re.IGNORECASE)
        if not match:
            return default_limit

        try:
            limit = int(match.group(1))
        except ValueError:
            return default_limit

        return max(1, min(limit, 100))

    async def extract_message_reference(self, text: str) -> str | None:
        """Extract a message reference (snowflake or 'last')."""
        if not text:
            return None

        id_match = re.search(r"\b(\d{17,19})\b", text)
        if id_match:
            return id_match.group(1)

        lowered = text.lower()
        if "last message" in lowered or "previous message" in lowered or "last" in lowered:
            return "last"

        return None

    async def extract_search_query(self, text: str) -> str | None:
        """Extract a search query from user text."""
        if not text:
            return None

        quoted = re.search(r"\"([^\"]+)\"", text)
        if quoted:
            q = quoted.group(1).strip()
            return q or None

        lowered = text.lower()
        for prefix in ("search for", "find", "look for", "search"):
            if prefix in lowered:
                idx = lowered.find(prefix) + len(prefix)
                q = text[idx:].strip(" :\n\t")
                return q or None

        q = text.strip()
        return q or None

    async def extract_media_url(self, text: str) -> str | None:
        """Extract the first URL from text."""
        if not text:
            return None

        match = re.search(r"(https?://[^\s>]+)", text)
        if match:
            return match.group(1)
        return None

    async def extract_reaction_info(self, text: str) -> ReactionInfo | None:
        """Extract an emoji and message reference from text."""
        if not text:
            return None

        emoji: str | None = None
        colon = re.search(r":([a-zA-Z0-9_]+):", text)
        if colon:
            emoji = f":{colon.group(1)}:"
        else:
            emoji_match = re.search(r"([\U0001F300-\U0001FAFF\u2600-\u27BF])", text)
            if emoji_match:
                emoji = emoji_match.group(1)

        message_ref = await self.extract_message_reference(text)
        if message_ref is None:
            message_ref = "last"

        if not emoji:
            return None

        return {"emoji": emoji, "message_ref": message_ref}

    async def extract_user_identifier(self, text: str) -> str | None:
        """Extract a user identifier (mention/id/username) from text."""
        if not text:
            return None

        mention = re.search(r"<@!?(\d{17,19})>", text)
        if mention:
            return mention.group(1)

        id_match = re.search(r"\b(\d{17,19})\b", text)
        if id_match:
            return id_match.group(1)

        # Fallback: last word
        parts = [p for p in re.split(r"\s+", text.strip()) if p]
        if parts:
            return parts[-1]

        return None

    # ---------------------------------------------------------------------
    # Permissions & data access helpers
    # ---------------------------------------------------------------------

    async def has_manage_messages_permission(self, channel_id: str) -> bool:
        """Check if the bot has Manage Messages in the channel."""
        try:
            channel = await self._get_text_channel(channel_id)
        except Exception:
            return False

        if isinstance(channel, discord.DMChannel):
            return False

        guild = getattr(channel, "guild", None)
        if guild is None:
            return False

        me = getattr(guild, "me", None)
        if me is None:
            return False

        perms = channel.permissions_for(me)
        return bool(getattr(perms, "manage_messages", False))

    async def has_read_message_history_permission(self, channel_id: str) -> bool:
        """Check if the bot can read message history in the channel."""
        try:
            channel = await self._get_text_channel(channel_id)
        except Exception:
            return False

        if isinstance(channel, discord.DMChannel):
            return True

        guild = getattr(channel, "guild", None)
        if guild is None:
            return False

        me = getattr(guild, "me", None)
        if me is None:
            return False

        perms = channel.permissions_for(me)
        return bool(getattr(perms, "read_message_history", False))

    async def get_channel_name(self, channel_id: str) -> str:
        """Best-effort channel name."""
        try:
            channel = await self._get_text_channel(channel_id)
        except Exception:
            return channel_id

        name = getattr(channel, "name", None)
        if isinstance(name, str) and name:
            return name

        # DMChannel has no "name"; use recipient info if present.
        recipient = getattr(channel, "recipient", None)
        recipient_name = getattr(recipient, "name", None) if recipient is not None else None
        if isinstance(recipient_name, str) and recipient_name:
            return f"DM with {recipient_name}"

        return channel_id

    async def get_channel_info(self, channel_id: str) -> ChannelInfoSummary | None:
        """Fetch channel information (name/server/mention)."""
        try:
            channel = await self._get_text_channel(channel_id)
        except Exception:
            return None

        name = await self.get_channel_name(channel_id)
        guild = getattr(channel, "guild", None)
        server = getattr(guild, "name", None) if guild is not None else None
        server_name = server if isinstance(server, str) and server else "Direct Message"

        return {
            "id": channel_id,
            "name": name,
            "server": server_name,
            "mention": f"<#{channel_id}>",
        }

    async def get_channel_messages(
        self, channel_id: str, limit: int
    ) -> list[DiscordMessageSummary]:
        channel = await self._get_text_channel(channel_id)

        msgs: list[DiscordMessageSummary] = []
        async for message in channel.history(limit=max(1, min(limit, 100))):
            msgs.append(self._map_message(message))
        return msgs

    async def search_messages(
        self,
        channel_id: str,
        query: str,
        *,
        limit: int = 50,
    ) -> list[DiscordMessageSummary]:
        """Naive client-side search over recent messages."""
        channel = await self._get_text_channel(channel_id)

        q = query.lower().strip()
        if not q:
            return []

        results: list[DiscordMessageSummary] = []
        async for message in channel.history(limit=200):
            if q in (message.content or "").lower():
                results.append(self._map_message(message))
                if len(results) >= limit:
                    break
        return results

    async def find_message(self, channel_id: str, message_ref: str) -> DiscordMessageSummary | None:
        """Find a message by ID or special reference like 'last'."""
        channel = await self._get_text_channel(channel_id)

        if message_ref == "last":
            async for message in channel.history(limit=1):
                return self._map_message(message)
            return None

        # message_ref as snowflake
        try:
            Snowflake(message_ref)
        except Exception:
            return None

        msg = await channel.fetch_message(Snowflake(message_ref).as_int())
        return self._map_message(msg)

    async def pin_message(self, channel_id: str, message_id: str) -> bool:
        try:
            channel = await self._get_text_channel(channel_id)
            msg = await channel.fetch_message(Snowflake(message_id).as_int())
            await msg.pin()
            return True
        except Exception:
            return False

    async def unpin_message(self, channel_id: str, message_id: str) -> bool:
        try:
            channel = await self._get_text_channel(channel_id)
            msg = await channel.fetch_message(Snowflake(message_id).as_int())
            await msg.unpin()
            return True
        except Exception:
            return False

    async def download_media(self, media_url: str) -> DownloadedMedia | None:
        """Download media to a temp file and return metadata."""
        if not media_url:
            return None

        import aiohttp

        async with aiohttp.ClientSession() as session, session.get(media_url) as resp:
            if resp.status != 200:
                return None

            content_type = resp.headers.get("Content-Type")
            data = await resp.read()

        filename = Path(media_url.split("?")[0]).name or "download"
        suffix = Path(filename).suffix

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(data)
            temp_path = f.name

        return {
            "path": temp_path,
            "filename": filename,
            "content_type": content_type,
        }

    async def send_file(
        self,
        channel_id: str,
        file_path: str,
        filename: str,
        content: str,
    ) -> Snowflake | None:
        """Send a file to a channel."""
        if self._client is None:
            raise ClientNotInitializedError()

        channel = await self._get_text_channel(channel_id)

        if not Path(file_path).exists():
            return None

        file = discord.File(file_path, filename=filename)
        msg = await channel.send(content or "", file=file)
        return Snowflake(str(msg.id))

    async def transcribe_media(self, media_url: str) -> str | None:
        """Best-effort transcription.

        The Python Discord plugin does not bundle a speech-to-text engine.
        For now, this supports text-like files only.
        """
        media = await self.download_media(media_url)
        if not media:
            return None

        path = Path(media["path"])
        if path.suffix.lower() not in {".txt", ".md", ".srt"}:
            return None

        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None

    async def generate_conversation_summary(self, conversation_text: str) -> str | None:
        if not conversation_text:
            return None

        # Heuristic: return a compact excerpt for now.
        max_len = 1500
        summary = conversation_text.strip()
        if len(summary) > max_len:
            summary = summary[:max_len].rstrip() + "…"
        return summary

    async def generate_summary(self, attachments_content: str, objective: str) -> str | None:
        """Generate a best-effort summary of attachment content."""
        if not attachments_content:
            return None

        header = objective.strip() or "Attachment summary"
        body = attachments_content.strip()
        if len(body) > 2500:
            body = body[:2500].rstrip() + "…"

        return f"## {header}\n\n{body}"

    async def parse_poll_info(self, text: str) -> PollInfo | None:
        """Parse poll question and options from text."""
        if not text:
            return None

        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        question = ""
        options: list[str] = []

        for line in lines:
            lower = line.lower()
            if lower.startswith("question:"):
                question = line.split(":", 1)[1].strip()
            if lower.startswith("options:"):
                raw = line.split(":", 1)[1]
                options = [o.strip() for o in raw.split(",") if o.strip()]

        if not question and lines:
            question = lines[0]

        if not options:
            for line in lines[1:]:
                m = re.match(r"^(?:[-*]|\d+[.)])\s*(.+)$", line)
                if m:
                    opt = m.group(1).strip()
                    if opt:
                        options.append(opt)

        if not options:
            options = ["Yes", "No"]

        return {"question": question, "options": options[:10], "use_emojis": True}

    async def send_poll(
        self, channel_id: str, poll_message: str, emojis: list[str]
    ) -> Snowflake | None:
        """Send a poll message and add reactions for the provided emoji options."""
        if not poll_message.strip() or not emojis:
            return None

        message_id = await self.send_message(channel_id, poll_message)
        for emoji in emojis:
            await self.add_reaction(channel_id, str(message_id), emoji)

        return message_id

    async def get_member_info(
        self, guild_id: str, user_identifier: str
    ) -> dict[str, object] | None:
        """Fetch basic member info by snowflake or username."""
        if self._client is None:
            raise ClientNotInitializedError()

        guild = self._client.get_guild(Snowflake(guild_id).as_int())
        if guild is None:
            guild = await self._client.fetch_guild(Snowflake(guild_id).as_int())

        member = None
        if re.fullmatch(r"\d{17,19}", user_identifier):
            member = guild.get_member(Snowflake(user_identifier).as_int())
            if member is None:
                try:
                    member = await guild.fetch_member(Snowflake(user_identifier).as_int())
                except Exception:
                    member = None
        else:
            # Best-effort search in cache
            for m in guild.members:
                if m.name == user_identifier or m.display_name == user_identifier:
                    member = m
                    break

        if member is None:
            return None

        return {
            "id": str(member.id),
            "username": member.name,
            "display_name": member.display_name,
            "joined_at": member.joined_at.isoformat() if member.joined_at else None,
            "roles": [str(r.id) for r in member.roles],
            "is_bot": member.bot,
        }

    def format_user_info(self, user_info: dict[str, object]) -> str:
        username = user_info.get("username")
        display_name = user_info.get("display_name")
        user_id = user_info.get("id")

        name = display_name if isinstance(display_name, str) and display_name else username
        if not isinstance(name, str) or not name:
            name = "Unknown"

        return f"**{name}** (`{user_id}`)"

    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------

    async def _get_text_channel(
        self, channel_id: str
    ) -> discord.TextChannel | discord.DMChannel | discord.Thread:
        if self._client is None:
            raise ClientNotInitializedError()

        snowflake = Snowflake(channel_id)
        channel = self._client.get_channel(snowflake.as_int())
        if channel is None:
            channel = await self._client.fetch_channel(snowflake.as_int())

        if not isinstance(channel, discord.TextChannel | discord.DMChannel | discord.Thread):
            raise InvalidArgumentError(f"Channel {channel_id} is not a text channel")

        return channel

    def _map_message(self, message: Message) -> DiscordMessageSummary:
        return {
            "id": str(message.id),
            "content": message.content,
            "pinned": bool(message.pinned),
            "author": {"id": str(message.author.id), "username": message.author.name},
            "timestamp": message.created_at.isoformat(),
        }


def split_message(content: str) -> list[str]:
    if len(content) <= MAX_MESSAGE_LENGTH:
        return [content]

    parts: list[str] = []
    current = ""

    for line in content.splitlines(keepends=True):
        if len(current) + len(line) > MAX_MESSAGE_LENGTH:
            if current:
                parts.append(current)
                current = ""

            if len(line) > MAX_MESSAGE_LENGTH:
                words = line.split()
                for word in words:
                    word_with_space = f" {word}" if current else word

                    if len(current) + len(word_with_space) > MAX_MESSAGE_LENGTH:
                        if current:
                            parts.append(current)
                            current = ""

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

    if current:
        parts.append(current)

    return parts
