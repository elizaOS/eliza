"""
Twitch service implementation for elizaOS.

This service provides Twitch chat integration using the twitchio library.
"""

import asyncio
import logging
import uuid
from typing import Callable, Optional

from twitchio import Message
from twitchio.ext import commands

from elizaos_plugin_twitch.types import (
    TwitchConfigurationError,
    TwitchEventTypes,
    TwitchMessage,
    TwitchMessageSendOptions,
    TwitchNotConnectedError,
    TwitchRole,
    TwitchSendResult,
    TwitchSettings,
    TwitchUserInfo,
    normalize_channel,
    split_message_for_twitch,
    strip_markdown_for_twitch,
    TWITCH_SERVICE_NAME,
)

logger = logging.getLogger(__name__)


class TwitchBot(commands.Bot):
    """Custom Twitch bot that inherits from twitchio.ext.commands.Bot."""

    def __init__(
        self,
        settings: TwitchSettings,
        on_message_callback: Optional[Callable[[TwitchMessage], None]] = None,
        on_ready_callback: Optional[Callable[[], None]] = None,
    ):
        """Initialize the Twitch bot."""
        all_channels = [settings.channel] + settings.additional_channels
        
        super().__init__(
            token=settings.access_token,
            prefix="!",
            initial_channels=[normalize_channel(c) for c in all_channels],
        )
        
        self.settings = settings
        self._on_message_callback = on_message_callback
        self._on_ready_callback = on_ready_callback
        self._connected = False
        self._joined_channels: set[str] = set()

    async def event_ready(self) -> None:
        """Called when the bot is ready."""
        self._connected = True
        logger.info(f"Logged in as {self.nick}")
        
        if self._on_ready_callback:
            self._on_ready_callback()

    async def event_channel_joined(self, channel) -> None:
        """Called when the bot joins a channel."""
        channel_name = normalize_channel(channel.name)
        self._joined_channels.add(channel_name)
        logger.info(f"Joined channel: #{channel_name}")

    async def event_message(self, message: Message) -> None:
        """Called when a message is received."""
        if message.echo:
            return

        if not message.author:
            return

        # Check if it's the bot's own message
        if message.author.name.lower() == self.settings.username.lower():
            return

        user_info = TwitchUserInfo(
            user_id=str(message.author.id) if message.author.id else "",
            username=message.author.name,
            display_name=message.author.display_name or message.author.name,
            is_moderator=message.author.is_mod,
            is_broadcaster=message.author.is_broadcaster,
            is_vip=getattr(message.author, "is_vip", False),
            is_subscriber=message.author.is_subscriber,
            color=message.author.color,
            badges={},
        )

        channel_name = normalize_channel(message.channel.name)

        twitch_message = TwitchMessage(
            id=message.id or str(uuid.uuid4()),
            channel=channel_name,
            text=message.content,
            user=user_info,
            timestamp=message.timestamp.timestamp() if message.timestamp else 0,
            is_action=False,
            is_highlighted=False,
        )

        if self._on_message_callback:
            self._on_message_callback(twitch_message)

    @property
    def is_connected(self) -> bool:
        """Check if the bot is connected."""
        return self._connected

    @property
    def joined_channels(self) -> set[str]:
        """Get the set of joined channels."""
        return self._joined_channels


class TwitchService:
    """Twitch chat service for elizaOS agents."""

    service_type: str = TWITCH_SERVICE_NAME

    def __init__(self, runtime):
        """Initialize the Twitch service."""
        self.runtime = runtime
        self.settings: Optional[TwitchSettings] = None
        self.bot: Optional[TwitchBot] = None
        self._task: Optional[asyncio.Task] = None

    @classmethod
    async def start(cls, runtime) -> "TwitchService":
        """Start the Twitch service."""
        service = cls(runtime)
        await service._initialize()
        return service

    async def stop(self) -> None:
        """Stop the Twitch service."""
        if self.bot:
            await self.bot.close()
        
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        
        logger.info("Twitch service stopped")

    async def _initialize(self) -> None:
        """Initialize the Twitch service with configuration."""
        # Load settings
        self.settings = self._load_settings()
        
        # Validate settings
        self._validate_settings()

        # Create bot
        self.bot = TwitchBot(
            settings=self.settings,
            on_message_callback=self._handle_message,
            on_ready_callback=self._handle_ready,
        )

        # Start bot in background
        self._task = asyncio.create_task(self.bot.start())

        # Wait for connection
        for _ in range(30):
            if self.bot.is_connected:
                break
            await asyncio.sleep(1)

        if not self.bot.is_connected:
            raise TwitchConfigurationError("Failed to connect to Twitch")

        logger.info(
            f"Twitch service initialized for {self.settings.username}, "
            f"channels: {self.settings.channel}"
        )

    def _load_settings(self) -> TwitchSettings:
        """Load settings from runtime."""
        username = self.runtime.get_setting("TWITCH_USERNAME") or ""
        client_id = self.runtime.get_setting("TWITCH_CLIENT_ID") or ""
        access_token = self.runtime.get_setting("TWITCH_ACCESS_TOKEN") or ""
        client_secret = self.runtime.get_setting("TWITCH_CLIENT_SECRET")
        refresh_token = self.runtime.get_setting("TWITCH_REFRESH_TOKEN")
        channel = self.runtime.get_setting("TWITCH_CHANNEL") or ""
        additional_channels_str = self.runtime.get_setting("TWITCH_CHANNELS")
        require_mention_str = self.runtime.get_setting("TWITCH_REQUIRE_MENTION")
        allowed_roles_str = self.runtime.get_setting("TWITCH_ALLOWED_ROLES")

        additional_channels = (
            [c.strip() for c in additional_channels_str.split(",") if c.strip()]
            if additional_channels_str
            else []
        )

        allowed_roles = (
            [r.strip().lower() for r in allowed_roles_str.split(",")]
            if allowed_roles_str
            else ["all"]
        )

        return TwitchSettings(
            username=username,
            client_id=client_id,
            access_token=access_token,
            client_secret=client_secret,
            refresh_token=refresh_token,
            channel=channel,
            additional_channels=additional_channels,
            require_mention=require_mention_str == "true",
            allowed_roles=allowed_roles,
        )

    def _validate_settings(self) -> None:
        """Validate the settings."""
        if not self.settings:
            raise TwitchConfigurationError("Settings not loaded")

        if not self.settings.username:
            raise TwitchConfigurationError(
                "TWITCH_USERNAME is required", "TWITCH_USERNAME"
            )

        if not self.settings.client_id:
            raise TwitchConfigurationError(
                "TWITCH_CLIENT_ID is required", "TWITCH_CLIENT_ID"
            )

        if not self.settings.access_token:
            raise TwitchConfigurationError(
                "TWITCH_ACCESS_TOKEN is required", "TWITCH_ACCESS_TOKEN"
            )

        if not self.settings.channel:
            raise TwitchConfigurationError(
                "TWITCH_CHANNEL is required", "TWITCH_CHANNEL"
            )

    def _handle_message(self, message: TwitchMessage) -> None:
        """Handle an incoming message."""
        if not self.settings:
            return

        # Check access control
        if not self.is_user_allowed(message.user):
            return

        # Check mention requirement
        if self.settings.require_mention:
            mention_pattern = f"@{self.settings.username}"
            if mention_pattern.lower() not in message.text.lower():
                return

        logger.debug(
            f"Twitch message from {message.user.display_name} in #{message.channel}: "
            f"{message.text[:50]}..."
        )

        if hasattr(self.runtime, "emit_event"):
            asyncio.create_task(
                self.runtime.emit_event(
                    TwitchEventTypes.MESSAGE_RECEIVED.value,
                    {"message": message, "runtime": self.runtime},
                )
            )

    def _handle_ready(self) -> None:
        """Handle connection ready."""
        if hasattr(self.runtime, "emit_event"):
            asyncio.create_task(
                self.runtime.emit_event(TwitchEventTypes.CONNECTION_READY.value, {})
            )

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self.bot is not None and self.bot.is_connected

    def get_bot_username(self) -> str:
        """Get the bot username."""
        return self.settings.username if self.settings else ""

    def get_primary_channel(self) -> str:
        """Get the primary channel."""
        return self.settings.channel if self.settings else ""

    def get_joined_channels(self) -> list[str]:
        """Get all joined channels."""
        if not self.bot:
            return []
        return list(self.bot.joined_channels)

    def is_user_allowed(self, user: TwitchUserInfo) -> bool:
        """Check if a user is allowed to interact based on settings."""
        if not self.settings:
            return False

        # Check allowlist first
        if self.settings.allowed_user_ids:
            if user.user_id not in self.settings.allowed_user_ids:
                return False

        # Check roles
        if "all" in self.settings.allowed_roles:
            return True

        if "owner" in self.settings.allowed_roles and user.is_broadcaster:
            return True

        if "moderator" in self.settings.allowed_roles and user.is_moderator:
            return True

        if "vip" in self.settings.allowed_roles and user.is_vip:
            return True

        if "subscriber" in self.settings.allowed_roles and user.is_subscriber:
            return True

        return False

    async def send_message(
        self,
        text: str,
        options: Optional[TwitchMessageSendOptions] = None,
    ) -> TwitchSendResult:
        """Send a message to a channel."""
        if not self.bot or not self.bot.is_connected:
            raise TwitchNotConnectedError()

        if not self.settings:
            raise TwitchNotConnectedError("Settings not loaded")

        channel_name = normalize_channel(
            options.channel if options and options.channel else self.settings.channel
        )

        # Strip markdown for Twitch
        cleaned_text = strip_markdown_for_twitch(text)
        if not cleaned_text:
            return TwitchSendResult(success=True, message_id="skipped-empty")

        # Split long messages
        chunks = split_message_for_twitch(cleaned_text)

        message_id: Optional[str] = None

        channel = self.bot.get_channel(channel_name)
        if not channel:
            return TwitchSendResult(
                success=False,
                error=f"Not in channel #{channel_name}",
            )

        for chunk in chunks:
            await channel.send(chunk)
            message_id = str(uuid.uuid4())

            # Small delay between chunks
            if len(chunks) > 1:
                await asyncio.sleep(0.3)

        if hasattr(self.runtime, "emit_event"):
            await self.runtime.emit_event(
                TwitchEventTypes.MESSAGE_SENT.value,
                {"channel": channel_name, "text": cleaned_text, "message_id": message_id},
            )

        return TwitchSendResult(success=True, message_id=message_id)

    async def join_channel(self, channel: str) -> None:
        """Join a channel."""
        if not self.bot:
            raise TwitchNotConnectedError()

        normalized = normalize_channel(channel)
        await self.bot.join_channels([normalized])

    async def leave_channel(self, channel: str) -> None:
        """Leave a channel."""
        if not self.bot:
            raise TwitchNotConnectedError()

        normalized = normalize_channel(channel)
        await self.bot.part_channels([normalized])
