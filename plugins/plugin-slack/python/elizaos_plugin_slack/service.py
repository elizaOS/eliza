"""
Slack service implementation for elizaOS.
"""

import asyncio
import logging
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass

from slack_bolt.async_app import AsyncApp
from slack_sdk.web.async_client import AsyncWebClient
from slack_sdk.errors import SlackApiError as SDKSlackApiError

from .types import (
    SLACK_SERVICE_NAME,
    MAX_SLACK_MESSAGE_LENGTH,
    SlackChannel,
    SlackChannelPurpose,
    SlackChannelTopic,
    SlackEventTypes,
    SlackFile,
    SlackMessage,
    SlackReaction,
    SlackSettings,
    SlackUser,
    SlackUserProfile,
    get_slack_channel_type,
    get_slack_user_display_name,
    is_valid_channel_id,
)


logger = logging.getLogger(__name__)


class SlackService:
    """
    Slack service for interacting with Slack via Socket Mode.
    """
    
    service_type = SLACK_SERVICE_NAME
    capability_description = "The agent is able to send and receive messages on Slack"
    
    def __init__(self, runtime: Any):
        self.runtime = runtime
        self.app: Optional[AsyncApp] = None
        self.client: Optional[AsyncWebClient] = None
        self.bot_user_id: Optional[str] = None
        self.team_id: Optional[str] = None
        self.character = runtime.character
        self.settings = self._load_settings()
        self._user_cache: Dict[str, SlackUser] = {}
        self._channel_cache: Dict[str, SlackChannel] = {}
        self._allowed_channel_ids: set = set()
        self._dynamic_channel_ids: set = set()
        self._is_starting = False
        self._is_connected = False
        
        # Parse allowed channel IDs
        channel_ids_raw = runtime.get_setting("SLACK_CHANNEL_IDS")
        if channel_ids_raw and channel_ids_raw.strip():
            for channel_id in channel_ids_raw.split(","):
                channel_id = channel_id.strip()
                if channel_id and is_valid_channel_id(channel_id):
                    self._allowed_channel_ids.add(channel_id)
    
    def _load_settings(self) -> SlackSettings:
        """Load Slack settings from runtime."""
        ignore_bot = self.runtime.get_setting("SLACK_SHOULD_IGNORE_BOT_MESSAGES")
        respond_mentions = self.runtime.get_setting("SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS")
        
        return SlackSettings(
            should_ignore_bot_messages=ignore_bot in ("true", "True", True),
            should_respond_only_to_mentions=respond_mentions in ("true", "True", True),
        )
    
    @classmethod
    async def start(cls, runtime: Any) -> "SlackService":
        """Start the Slack service."""
        service = cls(runtime)
        
        bot_token = runtime.get_setting("SLACK_BOT_TOKEN")
        app_token = runtime.get_setting("SLACK_APP_TOKEN")
        
        if not bot_token or not bot_token.strip():
            logger.warning("SLACK_BOT_TOKEN not provided, Slack service will not start")
            return service
        
        if not app_token or not app_token.strip():
            logger.warning("SLACK_APP_TOKEN not provided, Socket Mode will not work")
            return service
        
        service._bot_token = bot_token
        service._app_token = app_token
        service._signing_secret = runtime.get_setting("SLACK_SIGNING_SECRET")
        service._user_token = runtime.get_setting("SLACK_USER_TOKEN")
        
        await service._initialize()
        
        return service
    
    @classmethod
    async def stop(cls, runtime: Any) -> None:
        """Stop the Slack service."""
        service = runtime.get_service(SLACK_SERVICE_NAME)
        if service:
            await service._shutdown()
    
    async def _initialize(self) -> None:
        """Initialize the Slack service."""
        if self._is_starting or self._is_connected:
            return
        
        self._is_starting = True
        
        logger.info("Initializing Slack service with Socket Mode")
        
        self.app = AsyncApp(
            token=self._bot_token,
            signing_secret=self._signing_secret,
        )
        
        self.client = self.app.client
        
        # Get bot user info
        auth_result = await self.client.auth_test()
        self.bot_user_id = auth_result.get("user_id")
        self.team_id = auth_result.get("team_id")
        
        logger.info(f"Slack bot authenticated: user_id={self.bot_user_id}, team_id={self.team_id}")
        
        # Register event handlers
        self._register_event_handlers()
        
        self._is_connected = True
        self._is_starting = False
        
        logger.info("Slack service started successfully")
    
    async def _shutdown(self) -> None:
        """Shutdown the Slack service."""
        self.app = None
        self.client = None
        self._is_connected = False
        logger.info("Slack service stopped")
    
    def _register_event_handlers(self) -> None:
        """Register event handlers for the Slack app."""
        if not self.app:
            return
        
        @self.app.event("message")
        async def handle_message(event: dict, say: Callable) -> None:
            await self._handle_message(event, say)
        
        @self.app.event("app_mention")
        async def handle_app_mention(event: dict, say: Callable) -> None:
            await self._handle_app_mention(event, say)
        
        @self.app.event("reaction_added")
        async def handle_reaction_added(event: dict) -> None:
            await self._handle_reaction_added(event)
        
        @self.app.event("reaction_removed")
        async def handle_reaction_removed(event: dict) -> None:
            await self._handle_reaction_removed(event)
    
    async def _handle_message(self, event: dict, say: Callable) -> None:
        """Handle incoming messages."""
        # Ignore bot messages if configured
        if self.settings.should_ignore_bot_messages and event.get("bot_id"):
            return
        
        # Ignore messages from self
        if event.get("user") == self.bot_user_id:
            return
        
        # Check channel restrictions
        channel_id = event.get("channel", "")
        if not self._is_channel_allowed(channel_id):
            return
        
        # Check if we should only respond to mentions
        text = event.get("text", "")
        is_mentioned = f"<@{self.bot_user_id}>" in text
        if self.settings.should_respond_only_to_mentions and not is_mentioned:
            return
        
        # Emit event (in production, would process through runtime)
        logger.debug(f"Message received in channel {channel_id}: {text[:50]}...")
    
    async def _handle_app_mention(self, event: dict, say: Callable) -> None:
        """Handle app mentions."""
        channel_id = event.get("channel", "")
        user_id = event.get("user", "")
        text = event.get("text", "")
        
        # Remove bot mention from text
        if self.bot_user_id:
            text = text.replace(f"<@{self.bot_user_id}>", "").strip()
        
        logger.debug(f"App mention from {user_id} in {channel_id}: {text[:50]}...")
    
    async def _handle_reaction_added(self, event: dict) -> None:
        """Handle reaction added events."""
        logger.debug(f"Reaction added: {event.get('reaction')} by {event.get('user')}")
    
    async def _handle_reaction_removed(self, event: dict) -> None:
        """Handle reaction removed events."""
        logger.debug(f"Reaction removed: {event.get('reaction')} by {event.get('user')}")
    
    def _is_channel_allowed(self, channel_id: str) -> bool:
        """Check if a channel is in the allowed list."""
        if not self._allowed_channel_ids and not self._dynamic_channel_ids:
            return True
        return channel_id in self._allowed_channel_ids or channel_id in self._dynamic_channel_ids
    
    async def get_user(self, user_id: str) -> Optional[SlackUser]:
        """Get user information by ID."""
        if user_id in self._user_cache:
            return self._user_cache[user_id]
        
        if not self.client:
            return None
        
        result = await self.client.users_info(user=user_id)
        user_data = result.get("user")
        if not user_data:
            return None
        
        profile_data = user_data.get("profile", {})
        profile = SlackUserProfile(
            title=profile_data.get("title"),
            phone=profile_data.get("phone"),
            skype=profile_data.get("skype"),
            real_name=profile_data.get("real_name"),
            real_name_normalized=profile_data.get("real_name_normalized"),
            display_name=profile_data.get("display_name"),
            display_name_normalized=profile_data.get("display_name_normalized"),
            status_text=profile_data.get("status_text"),
            status_emoji=profile_data.get("status_emoji"),
            status_expiration=profile_data.get("status_expiration"),
            avatar_hash=profile_data.get("avatar_hash"),
            email=profile_data.get("email"),
            image_24=profile_data.get("image_24"),
            image_32=profile_data.get("image_32"),
            image_48=profile_data.get("image_48"),
            image_72=profile_data.get("image_72"),
            image_192=profile_data.get("image_192"),
            image_512=profile_data.get("image_512"),
            image_1024=profile_data.get("image_1024"),
            image_original=profile_data.get("image_original"),
            team=profile_data.get("team"),
        )
        
        user = SlackUser(
            id=user_data.get("id"),
            team_id=user_data.get("team_id"),
            name=user_data.get("name"),
            deleted=user_data.get("deleted", False),
            real_name=user_data.get("real_name"),
            tz=user_data.get("tz"),
            tz_label=user_data.get("tz_label"),
            tz_offset=user_data.get("tz_offset"),
            profile=profile,
            is_admin=user_data.get("is_admin", False),
            is_owner=user_data.get("is_owner", False),
            is_primary_owner=user_data.get("is_primary_owner", False),
            is_restricted=user_data.get("is_restricted", False),
            is_ultra_restricted=user_data.get("is_ultra_restricted", False),
            is_bot=user_data.get("is_bot", False),
            is_app_user=user_data.get("is_app_user", False),
            updated=user_data.get("updated", 0),
        )
        
        self._user_cache[user_id] = user
        return user
    
    async def get_channel(self, channel_id: str) -> Optional[SlackChannel]:
        """Get channel information by ID."""
        if channel_id in self._channel_cache:
            return self._channel_cache[channel_id]
        
        if not self.client:
            return None
        
        result = await self.client.conversations_info(channel=channel_id)
        channel_data = result.get("channel")
        if not channel_data:
            return None
        
        topic_data = channel_data.get("topic")
        topic = SlackChannelTopic(
            value=topic_data.get("value", ""),
            creator=topic_data.get("creator", ""),
            last_set=topic_data.get("last_set", 0),
        ) if topic_data else None
        
        purpose_data = channel_data.get("purpose")
        purpose = SlackChannelPurpose(
            value=purpose_data.get("value", ""),
            creator=purpose_data.get("creator", ""),
            last_set=purpose_data.get("last_set", 0),
        ) if purpose_data else None
        
        channel = SlackChannel(
            id=channel_data.get("id"),
            name=channel_data.get("name", ""),
            is_channel=channel_data.get("is_channel", False),
            is_group=channel_data.get("is_group", False),
            is_im=channel_data.get("is_im", False),
            is_mpim=channel_data.get("is_mpim", False),
            is_private=channel_data.get("is_private", False),
            is_archived=channel_data.get("is_archived", False),
            is_general=channel_data.get("is_general", False),
            is_shared=channel_data.get("is_shared", False),
            is_org_shared=channel_data.get("is_org_shared", False),
            is_member=channel_data.get("is_member", False),
            topic=topic,
            purpose=purpose,
            num_members=channel_data.get("num_members"),
            created=channel_data.get("created", 0),
            creator=channel_data.get("creator", ""),
        )
        
        self._channel_cache[channel_id] = channel
        return channel
    
    async def send_message(
        self,
        channel_id: str,
        text: str,
        thread_ts: Optional[str] = None,
        reply_broadcast: Optional[bool] = None,
        unfurl_links: Optional[bool] = None,
        unfurl_media: Optional[bool] = None,
    ) -> Dict[str, str]:
        """Send a message to a channel."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        # Split message if too long
        messages = self._split_message(text)
        last_ts = ""
        
        for msg in messages:
            result = await self.client.chat_postMessage(
                channel=channel_id,
                text=msg,
                thread_ts=thread_ts,
                reply_broadcast=reply_broadcast,
                unfurl_links=unfurl_links,
                unfurl_media=unfurl_media,
                mrkdwn=True,
            )
            last_ts = result.get("ts", "")
        
        return {"ts": last_ts, "channel_id": channel_id}
    
    async def send_reaction(self, channel_id: str, message_ts: str, emoji: str) -> None:
        """Add a reaction to a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        clean_emoji = emoji.strip(":").strip()
        await self.client.reactions_add(
            channel=channel_id,
            timestamp=message_ts,
            name=clean_emoji,
        )
    
    async def remove_reaction(self, channel_id: str, message_ts: str, emoji: str) -> None:
        """Remove a reaction from a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        clean_emoji = emoji.strip(":").strip()
        await self.client.reactions_remove(
            channel=channel_id,
            timestamp=message_ts,
            name=clean_emoji,
        )
    
    async def edit_message(self, channel_id: str, message_ts: str, text: str) -> None:
        """Edit a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        await self.client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=text,
        )
    
    async def delete_message(self, channel_id: str, message_ts: str) -> None:
        """Delete a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        await self.client.chat_delete(
            channel=channel_id,
            ts=message_ts,
        )
    
    async def pin_message(self, channel_id: str, message_ts: str) -> None:
        """Pin a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        await self.client.pins_add(
            channel=channel_id,
            timestamp=message_ts,
        )
    
    async def unpin_message(self, channel_id: str, message_ts: str) -> None:
        """Unpin a message."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        await self.client.pins_remove(
            channel=channel_id,
            timestamp=message_ts,
        )
    
    async def list_pins(self, channel_id: str) -> List[SlackMessage]:
        """List pinned messages in a channel."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        result = await self.client.pins_list(channel=channel_id)
        items = result.get("items", [])
        
        messages = []
        for item in items:
            if item.get("type") == "message" and item.get("message"):
                msg = item["message"]
                messages.append(SlackMessage(
                    type=msg.get("type", ""),
                    subtype=msg.get("subtype"),
                    ts=msg.get("ts", ""),
                    user=msg.get("user"),
                    text=msg.get("text", ""),
                    thread_ts=msg.get("thread_ts"),
                    reply_count=msg.get("reply_count"),
                    reply_users_count=msg.get("reply_users_count"),
                    latest_reply=msg.get("latest_reply"),
                ))
        
        return messages
    
    async def read_history(
        self,
        channel_id: str,
        limit: int = 100,
        before: Optional[str] = None,
        after: Optional[str] = None,
    ) -> List[SlackMessage]:
        """Read message history from a channel."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        result = await self.client.conversations_history(
            channel=channel_id,
            limit=limit,
            latest=before,
            oldest=after,
        )
        
        messages = []
        for msg in result.get("messages", []):
            messages.append(SlackMessage(
                type=msg.get("type", ""),
                subtype=msg.get("subtype"),
                ts=msg.get("ts", ""),
                user=msg.get("user"),
                text=msg.get("text", ""),
                thread_ts=msg.get("thread_ts"),
                reply_count=msg.get("reply_count"),
                reply_users_count=msg.get("reply_users_count"),
                latest_reply=msg.get("latest_reply"),
            ))
        
        return messages
    
    async def list_channels(
        self,
        types: str = "public_channel,private_channel",
        limit: int = 1000,
    ) -> List[SlackChannel]:
        """List channels in the workspace."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        result = await self.client.conversations_list(
            types=types,
            limit=limit,
        )
        
        channels = []
        for ch in result.get("channels", []):
            topic_data = ch.get("topic")
            topic = SlackChannelTopic(
                value=topic_data.get("value", ""),
                creator=topic_data.get("creator", ""),
                last_set=topic_data.get("last_set", 0),
            ) if topic_data else None
            
            purpose_data = ch.get("purpose")
            purpose = SlackChannelPurpose(
                value=purpose_data.get("value", ""),
                creator=purpose_data.get("creator", ""),
                last_set=purpose_data.get("last_set", 0),
            ) if purpose_data else None
            
            channels.append(SlackChannel(
                id=ch.get("id"),
                name=ch.get("name", ""),
                is_channel=ch.get("is_channel", False),
                is_group=ch.get("is_group", False),
                is_im=ch.get("is_im", False),
                is_mpim=ch.get("is_mpim", False),
                is_private=ch.get("is_private", False),
                is_archived=ch.get("is_archived", False),
                is_general=ch.get("is_general", False),
                is_shared=ch.get("is_shared", False),
                is_org_shared=ch.get("is_org_shared", False),
                is_member=ch.get("is_member", False),
                topic=topic,
                purpose=purpose,
                num_members=ch.get("num_members"),
                created=ch.get("created", 0),
                creator=ch.get("creator", ""),
            ))
        
        return channels
    
    async def get_emoji_list(self) -> Dict[str, str]:
        """Get custom emoji in the workspace."""
        if not self.client:
            raise RuntimeError("Slack client not initialized")
        
        result = await self.client.emoji_list()
        return result.get("emoji", {})
    
    def _split_message(self, text: str) -> List[str]:
        """Split a message into chunks if it exceeds the max length."""
        if len(text) <= MAX_SLACK_MESSAGE_LENGTH:
            return [text]
        
        messages = []
        remaining = text
        
        while remaining:
            if len(remaining) <= MAX_SLACK_MESSAGE_LENGTH:
                messages.append(remaining)
                break
            
            # Find a good split point
            split_index = MAX_SLACK_MESSAGE_LENGTH
            
            last_newline = remaining.rfind("\n", 0, MAX_SLACK_MESSAGE_LENGTH)
            if last_newline > MAX_SLACK_MESSAGE_LENGTH // 2:
                split_index = last_newline + 1
            else:
                last_space = remaining.rfind(" ", 0, MAX_SLACK_MESSAGE_LENGTH)
                if last_space > MAX_SLACK_MESSAGE_LENGTH // 2:
                    split_index = last_space + 1
            
            messages.append(remaining[:split_index])
            remaining = remaining[split_index:]
        
        return messages
    
    def add_allowed_channel(self, channel_id: str) -> None:
        """Add a channel to the dynamic allowed list."""
        if is_valid_channel_id(channel_id):
            self._dynamic_channel_ids.add(channel_id)
    
    def remove_allowed_channel(self, channel_id: str) -> None:
        """Remove a channel from the dynamic allowed list."""
        self._dynamic_channel_ids.discard(channel_id)
    
    def get_allowed_channel_ids(self) -> List[str]:
        """Get all currently allowed channel IDs."""
        return list(self._allowed_channel_ids | self._dynamic_channel_ids)
    
    def is_service_connected(self) -> bool:
        """Check if the service is connected."""
        return self._is_connected and self.app is not None
    
    def get_bot_user_id(self) -> Optional[str]:
        """Get the bot's user ID."""
        return self.bot_user_id
    
    def get_team_id(self) -> Optional[str]:
        """Get the team/workspace ID."""
        return self.team_id
    
    def clear_user_cache(self) -> None:
        """Clear the user cache."""
        self._user_cache.clear()
    
    def clear_channel_cache(self) -> None:
        """Clear the channel cache."""
        self._channel_cache.clear()
