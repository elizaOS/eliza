"""
LINE service implementation for elizaOS.
"""

import logging

from linebot.v3 import WebhookParser
from linebot.v3.messaging import (
    ApiClient,
    Configuration,
    FlexContainer,
    FlexMessage,
    LocationMessage,
    MessagingApi,
    PushMessageRequest,
    ReplyMessageRequest,
    TemplateMessage,
    TextMessage,
)

from .types import (
    LINE_SERVICE_NAME,
    MAX_LINE_BATCH_SIZE,
    LineApiError,
    LineConfigurationError,
    LineEventTypes,
    LineFlexMessage,
    LineGroup,
    LineLocationMessage,
    LineSendResult,
    LineSettings,
    LineTemplateMessage,
    LineUser,
    get_chat_type_from_id,
    split_message_for_line,
)

logger = logging.getLogger(__name__)


class LineService:
    """LINE messaging service for elizaOS agents."""

    service_type = LINE_SERVICE_NAME

    def __init__(self):
        self.runtime = None
        self.settings: LineSettings | None = None
        self._api_client: ApiClient | None = None
        self._messaging_api: MessagingApi | None = None
        self._parser: WebhookParser | None = None
        self._connected = False

    async def start(self, runtime) -> None:
        """Start the LINE service."""
        logger.info("Starting LINE service...")
        self.runtime = runtime

        # Load settings
        self.settings = self._load_settings()
        self._validate_settings()

        # Initialize LINE client
        configuration = Configuration(
            access_token=self.settings.channel_access_token
        )
        self._api_client = ApiClient(configuration)
        self._messaging_api = MessagingApi(self._api_client)
        self._parser = WebhookParser(self.settings.channel_secret)

        self._connected = True
        logger.info("LINE service started")

        # Emit connection ready event
        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(LineEventTypes.CONNECTION_READY, {"service": self})

    async def stop(self) -> None:
        """Stop the LINE service."""
        logger.info("Stopping LINE service...")
        self._connected = False
        self._messaging_api = None
        self._api_client = None
        self._parser = None
        self.settings = None
        self.runtime = None
        logger.info("LINE service stopped")

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected and self._messaging_api is not None

    async def get_bot_info(self) -> LineUser | None:
        """Get bot info."""
        if not self._messaging_api:
            return None

        info = self._messaging_api.get_bot_info()
        return LineUser(
            user_id=info.user_id,
            display_name=info.display_name,
            picture_url=info.picture_url,
        )

    async def send_message(
        self,
        to: str,
        text: str,
        quick_reply_items: list | None = None,
    ) -> LineSendResult:
        """Send a text message."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        chunks = split_message_for_line(text)
        messages = [TextMessage(type="text", text=chunk) for chunk in chunks]

        # Add quick replies to last message if provided
        if quick_reply_items and messages:
            messages[-1].quick_reply = {"items": quick_reply_items}

        return await self._push_messages(to, messages)

    async def send_messages(
        self,
        to: str,
        messages: list[dict],
    ) -> LineSendResult:
        """Send multiple messages."""
        return await self._push_messages(to, messages)

    async def send_flex_message(
        self,
        to: str,
        flex: LineFlexMessage,
    ) -> LineSendResult:
        """Send a flex message."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        message = FlexMessage(
            type="flex",
            alt_text=flex.alt_text[:400],
            contents=FlexContainer.from_dict(flex.contents),
        )

        return await self._push_messages(to, [message])

    async def send_template_message(
        self,
        to: str,
        template: LineTemplateMessage,
    ) -> LineSendResult:
        """Send a template message."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        message = TemplateMessage(
            type="template",
            alt_text=template.alt_text[:400],
            template=template.template,
        )

        return await self._push_messages(to, [message])

    async def send_location_message(
        self,
        to: str,
        location: LineLocationMessage,
    ) -> LineSendResult:
        """Send a location message."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        message = LocationMessage(
            type="location",
            title=location.title[:100],
            address=location.address[:100],
            latitude=location.latitude,
            longitude=location.longitude,
        )

        return await self._push_messages(to, [message])

    async def reply_message(
        self,
        reply_token: str,
        messages: list[dict],
    ) -> LineSendResult:
        """Reply to a message using reply token."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        request = ReplyMessageRequest(
            reply_token=reply_token,
            messages=messages[:MAX_LINE_BATCH_SIZE],
        )

        self._messaging_api.reply_message(request)

        return LineSendResult(
            success=True,
            message_id="reply",
            chat_id="reply",
        )

    async def get_user_profile(self, user_id: str) -> LineUser | None:
        """Get user profile."""
        if not self._messaging_api:
            return None

        profile = self._messaging_api.get_profile(user_id)
        return LineUser(
            user_id=profile.user_id,
            display_name=profile.display_name,
            picture_url=profile.picture_url,
            status_message=profile.status_message,
            language=profile.language,
        )

    async def get_group_info(self, group_id: str) -> LineGroup | None:
        """Get group info."""
        if not self._messaging_api:
            return None

        chat_type = get_chat_type_from_id(group_id)

        if chat_type == "group":
            summary = self._messaging_api.get_group_summary(group_id)
            return LineGroup(
                group_id=summary.group_id,
                group_type="group",
                group_name=summary.group_name,
                picture_url=summary.picture_url,
            )
        elif chat_type == "room":
            return LineGroup(
                group_id=group_id,
                group_type="room",
            )

        return None

    async def leave_chat(self, chat_id: str, chat_type: str) -> None:
        """Leave a group or room."""
        if not self._messaging_api:
            raise LineApiError("Service not connected")

        if chat_type == "group":
            self._messaging_api.leave_group(chat_id)
        else:
            self._messaging_api.leave_room(chat_id)

    def get_settings(self) -> LineSettings | None:
        """Get current settings."""
        return self.settings

    def create_webhook_handler(self):
        """Create a WebhookHandler for processing webhook events.

        Returns:
            A WebhookHandler configured with this service's channel secret.

        Raises:
            LineConfigurationError: If the service is not configured.
        """
        from .webhook import WebhookHandler

        if not self.settings:
            raise LineConfigurationError("Service not configured")
        return WebhookHandler(self.settings.channel_secret)

    async def handle_webhook_events(self, events) -> None:
        """Handle a list of parsed webhook events, dispatching to runtime."""
        for event in events:
            await self._handle_webhook_event(event)

    async def _handle_webhook_event(self, event) -> None:
        """Handle a single webhook event, emitting runtime events."""
        from .webhook import (
            FollowEvent,
            JoinEvent,
            LeaveEvent,
            MessageEvent,
            PostbackEvent,
            UnfollowEvent,
        )

        if not self.runtime:
            return

        emit = getattr(self.runtime, "emit", None)
        if not emit:
            return

        if isinstance(event, FollowEvent):
            emit(LineEventTypes.FOLLOW, {
                "user_id": event.source.user_id,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, UnfollowEvent):
            emit(LineEventTypes.UNFOLLOW, {
                "user_id": event.source.user_id,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, JoinEvent):
            emit(LineEventTypes.JOIN_GROUP, {
                "group_id": event.source.group_id or event.source.room_id,
                "type": event.source.type,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, LeaveEvent):
            emit(LineEventTypes.LEAVE_GROUP, {
                "group_id": event.source.group_id or event.source.room_id,
                "type": event.source.type,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, PostbackEvent):
            emit(LineEventTypes.POSTBACK, {
                "user_id": event.source.user_id,
                "data": event.data,
                "params": event.params,
                "timestamp": event.timestamp,
            })
        elif isinstance(event, MessageEvent):
            await self._handle_message_webhook_event(event)

    async def _handle_message_webhook_event(self, event) -> None:
        """Handle a message webhook event."""
        if not self.runtime:
            return

        message = LineMessage(
            id=event.message_id,
            message_type=event.message_type,
            user_id=event.source.user_id or "",
            timestamp=event.timestamp,
            text=event.text,
            group_id=event.source.group_id,
            room_id=event.source.room_id,
            reply_token=event.reply_token,
        )

        emit = getattr(self.runtime, "emit", None)
        if emit:
            emit(LineEventTypes.MESSAGE_RECEIVED, {
                "message": message,
                "source": {
                    "type": event.source.type,
                    "userId": event.source.user_id,
                    "groupId": event.source.group_id,
                    "roomId": event.source.room_id,
                },
                "reply_token": event.reply_token,
            })

    # Private methods

    def _load_settings(self) -> LineSettings:
        """Load settings from runtime and environment."""
        import os

        if not self.runtime:
            raise LineConfigurationError("Runtime not initialized")

        get_setting = getattr(self.runtime, "get_setting", lambda x: None)

        channel_access_token = (
            get_setting("LINE_CHANNEL_ACCESS_TOKEN")
            or os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
        )

        channel_secret = (
            get_setting("LINE_CHANNEL_SECRET")
            or os.environ.get("LINE_CHANNEL_SECRET", "")
        )

        webhook_path = (
            get_setting("LINE_WEBHOOK_PATH")
            or os.environ.get("LINE_WEBHOOK_PATH", "/webhooks/line")
        )

        dm_policy = (
            get_setting("LINE_DM_POLICY")
            or os.environ.get("LINE_DM_POLICY", "pairing")
        )

        group_policy = (
            get_setting("LINE_GROUP_POLICY")
            or os.environ.get("LINE_GROUP_POLICY", "allowlist")
        )

        allow_from_raw = (
            get_setting("LINE_ALLOW_FROM")
            or os.environ.get("LINE_ALLOW_FROM", "")
        )
        allow_from = [s.strip() for s in allow_from_raw.split(",") if s.strip()]

        enabled_raw = (
            get_setting("LINE_ENABLED")
            or os.environ.get("LINE_ENABLED", "true")
        )
        enabled = enabled_raw.lower() != "false"

        return LineSettings(
            channel_access_token=channel_access_token,
            channel_secret=channel_secret,
            webhook_path=webhook_path,
            dm_policy=dm_policy,
            group_policy=group_policy,
            allow_from=allow_from,
            enabled=enabled,
        )

    def _validate_settings(self) -> None:
        """Validate settings."""
        if not self.settings:
            raise LineConfigurationError("Settings not loaded")

        if not self.settings.channel_access_token:
            raise LineConfigurationError(
                "LINE_CHANNEL_ACCESS_TOKEN is required",
                "LINE_CHANNEL_ACCESS_TOKEN",
            )

        if not self.settings.channel_secret:
            raise LineConfigurationError(
                "LINE_CHANNEL_SECRET is required",
                "LINE_CHANNEL_SECRET",
            )

    async def _push_messages(self, to: str, messages: list) -> LineSendResult:
        """Push messages to a target."""
        if not self._messaging_api:
            return LineSendResult(success=False, error="Service not connected")

        # Send in batches of 5
        for i in range(0, len(messages), MAX_LINE_BATCH_SIZE):
            batch = messages[i : i + MAX_LINE_BATCH_SIZE]

            request = PushMessageRequest(
                to=to,
                messages=batch,
            )

            self._messaging_api.push_message(request)

        # Emit sent event
        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(
                LineEventTypes.MESSAGE_SENT,
                {"to": to, "message_count": len(messages)},
            )

        return LineSendResult(
            success=True,
            message_id=str(int(__import__("time").time() * 1000)),
            chat_id=to,
        )
