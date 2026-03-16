"""
Google Chat service implementation for elizaOS.
"""

import json
import logging
import os
import uuid

import aiohttp
from google.auth.transport.requests import Request
from google.oauth2 import service_account

from .types import (
    GOOGLE_CHAT_SERVICE_NAME,
    GoogleChatApiError,
    GoogleChatAuthenticationError,
    GoogleChatConfigurationError,
    GoogleChatEvent,
    GoogleChatEventTypes,
    GoogleChatMessageSendOptions,
    GoogleChatReaction,
    GoogleChatSendResult,
    GoogleChatSettings,
    GoogleChatSpace,
)

logger = logging.getLogger(__name__)

CHAT_API_BASE = "https://chat.googleapis.com/v1"
CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1"
CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot"


class GoogleChatService:
    """Google Chat messaging service for elizaOS agents."""

    service_type = GOOGLE_CHAT_SERVICE_NAME

    def __init__(self):
        self.runtime = None
        self.settings: GoogleChatSettings | None = None
        self.credentials = None
        self._connected = False
        self._cached_spaces: list[GoogleChatSpace] = []
        self._session: aiohttp.ClientSession | None = None

    async def start(self, runtime) -> None:
        """Start the Google Chat service."""
        logger.info("Starting Google Chat service...")

        self.runtime = runtime
        self.settings = self._load_settings()
        self._validate_settings()

        # Initialize credentials
        await self._initialize_credentials()

        # Test connection
        await self._test_connection()

        self._connected = True
        logger.info("Google Chat service started successfully")

        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(GoogleChatEventTypes.CONNECTION_READY, {"service": self})

    async def stop(self) -> None:
        """Stop the Google Chat service."""
        logger.info("Stopping Google Chat service...")
        self._connected = False

        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

        self.runtime = None
        self.credentials = None
        logger.info("Google Chat service stopped")

    def _load_settings(self) -> GoogleChatSettings:
        """Load settings from runtime configuration."""
        if not self.runtime:
            raise GoogleChatConfigurationError("Runtime not initialized")

        get_setting = getattr(self.runtime, "get_setting", lambda x: None)

        service_account = (
            get_setting("GOOGLE_CHAT_SERVICE_ACCOUNT")
            or os.environ.get("GOOGLE_CHAT_SERVICE_ACCOUNT")
            or ""
        )

        service_account_file = (
            get_setting("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE")
            or os.environ.get("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE")
            or ""
        )

        audience_type = (
            get_setting("GOOGLE_CHAT_AUDIENCE_TYPE")
            or os.environ.get("GOOGLE_CHAT_AUDIENCE_TYPE")
            or "app-url"
        )

        audience = (
            get_setting("GOOGLE_CHAT_AUDIENCE")
            or os.environ.get("GOOGLE_CHAT_AUDIENCE")
            or ""
        )

        webhook_path = (
            get_setting("GOOGLE_CHAT_WEBHOOK_PATH")
            or os.environ.get("GOOGLE_CHAT_WEBHOOK_PATH")
            or "/googlechat"
        )

        spaces_raw = (
            get_setting("GOOGLE_CHAT_SPACES")
            or os.environ.get("GOOGLE_CHAT_SPACES")
            or ""
        )

        require_mention = (
            get_setting("GOOGLE_CHAT_REQUIRE_MENTION")
            or os.environ.get("GOOGLE_CHAT_REQUIRE_MENTION")
            or "true"
        )

        enabled = (
            get_setting("GOOGLE_CHAT_ENABLED")
            or os.environ.get("GOOGLE_CHAT_ENABLED")
            or "true"
        )

        bot_user = (
            get_setting("GOOGLE_CHAT_BOT_USER")
            or os.environ.get("GOOGLE_CHAT_BOT_USER")
        )

        return GoogleChatSettings(
            service_account=service_account or None,
            service_account_file=service_account_file or None,
            audience_type=audience_type,
            audience=audience,
            webhook_path=webhook_path if webhook_path.startswith("/") else f"/{webhook_path}",
            spaces=[s.strip() for s in spaces_raw.split(",") if s.strip()] if spaces_raw else [],
            require_mention=require_mention.lower() != "false",
            enabled=enabled.lower() != "false",
            bot_user=bot_user or None,
        )

    def _validate_settings(self) -> None:
        """Validate the settings."""
        settings = self.settings
        if not settings:
            raise GoogleChatConfigurationError("Settings not loaded")

        if not settings.service_account and not settings.service_account_file:
            if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
                raise GoogleChatConfigurationError(
                    "Google Chat requires service account credentials. "
                    "Set GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE, "
                    "or GOOGLE_APPLICATION_CREDENTIALS.",
                    "GOOGLE_CHAT_SERVICE_ACCOUNT",
                )

        if not settings.audience:
            raise GoogleChatConfigurationError(
                "GOOGLE_CHAT_AUDIENCE is required for webhook verification",
                "GOOGLE_CHAT_AUDIENCE",
            )

        if settings.audience_type not in ("app-url", "project-number"):
            raise GoogleChatConfigurationError(
                "GOOGLE_CHAT_AUDIENCE_TYPE must be 'app-url' or 'project-number'",
                "GOOGLE_CHAT_AUDIENCE_TYPE",
            )

    async def _initialize_credentials(self) -> None:
        """Initialize Google credentials."""
        settings = self.settings
        if not settings:
            raise GoogleChatConfigurationError("Settings not loaded")

        if settings.service_account_file:
            self.credentials = service_account.Credentials.from_service_account_file(
                settings.service_account_file,
                scopes=[CHAT_SCOPE],
            )
        elif settings.service_account:
            info = json.loads(settings.service_account)
            self.credentials = service_account.Credentials.from_service_account_info(
                info,
                scopes=[CHAT_SCOPE],
            )
        else:
            # Use Application Default Credentials
            import google.auth

            self.credentials, _ = google.auth.default(scopes=[CHAT_SCOPE])

        logger.info("Google credentials initialized")

    async def _test_connection(self) -> None:
        """Test the connection to Google Chat API."""
        token = await self.get_access_token()
        if not token:
            raise GoogleChatAuthenticationError("Failed to obtain access token")

        session = await self._get_session()
        url = f"{CHAT_API_BASE}/spaces?pageSize=1"

        async with session.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        ) as response:
            if not response.ok:
                text = await response.text()
                raise GoogleChatApiError(
                    f"Failed to connect to Google Chat API: {text or response.reason}",
                    response.status,
                )

        logger.info("Google Chat API connection verified")

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create an aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected

    def get_bot_user(self) -> str | None:
        """Get the bot user name."""
        return self.settings.bot_user if self.settings else None

    async def get_access_token(self) -> str:
        """Get an access token for API calls."""
        if not self.credentials:
            raise GoogleChatAuthenticationError("Credentials not initialized")

        if not self.credentials.valid:
            self.credentials.refresh(Request())

        token = self.credentials.token
        if not token:
            raise GoogleChatAuthenticationError("Failed to obtain access token")

        return token

    async def _fetch_api(self, url: str, method: str = "GET", body: dict | None = None) -> dict:
        """Make an authenticated API request."""
        token = await self.get_access_token()
        session = await self._get_session()

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        kwargs = {"headers": headers}
        if body is not None:
            kwargs["json"] = body

        async with session.request(method, url, **kwargs) as response:
            if not response.ok:
                text = await response.text()
                raise GoogleChatApiError(
                    f"Google Chat API error: {text or response.reason}",
                    response.status,
                )
            return await response.json()

    async def get_spaces(self) -> list[GoogleChatSpace]:
        """Get spaces the bot is in."""
        url = f"{CHAT_API_BASE}/spaces"
        data = await self._fetch_api(url)

        spaces = []
        for space_data in data.get("spaces", []):
            space = GoogleChatSpace(
                name=space_data.get("name", ""),
                display_name=space_data.get("displayName"),
                type=space_data.get("type", "SPACE"),
                single_user_bot_dm=space_data.get("singleUserBotDm", False),
                threaded=space_data.get("threaded", False),
                space_type=space_data.get("spaceType"),
            )
            spaces.append(space)

        self._cached_spaces = spaces
        return spaces

    async def send_message(self, options: GoogleChatMessageSendOptions) -> GoogleChatSendResult:
        """Send a message to a space."""
        if not options.space:
            return GoogleChatSendResult(success=False, error="Space is required")

        body: dict = {}

        if options.text:
            body["text"] = options.text

        if options.thread:
            body["thread"] = {"name": options.thread}

        if options.attachments:
            body["attachment"] = [
                {
                    "attachmentDataRef": {"attachmentUploadToken": att["attachmentUploadToken"]},
                    **({"contentName": att["contentName"]} if att.get("contentName") else {}),
                }
                for att in options.attachments
            ]

        url = f"{CHAT_API_BASE}/{options.space}/messages"
        result = await self._fetch_api(url, "POST", body)

        message_name = result.get("name")
        logger.debug(f"Message sent to {options.space}: {message_name}")

        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(
                GoogleChatEventTypes.MESSAGE_SENT,
                {"messageName": message_name, "space": options.space},
            )

        return GoogleChatSendResult(
            success=True,
            message_name=message_name,
            space=options.space,
        )

    async def update_message(
        self, message_name: str, text: str
    ) -> dict:
        """Update a message."""
        url = f"{CHAT_API_BASE}/{message_name}?updateMask=text"
        result = await self._fetch_api(url, "PATCH", {"text": text})
        return {"success": True, "message_name": result.get("name")}

    async def delete_message(self, message_name: str) -> dict:
        """Delete a message."""
        token = await self.get_access_token()
        session = await self._get_session()
        url = f"{CHAT_API_BASE}/{message_name}"

        async with session.delete(
            url,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if not response.ok:
                text = await response.text()
                return {"success": False, "error": f"Failed to delete message: {text or response.reason}"}

        return {"success": True}

    async def send_reaction(self, message_name: str, emoji: str) -> dict:
        """Send a reaction to a message."""
        url = f"{CHAT_API_BASE}/{message_name}/reactions"
        result = await self._fetch_api(url, "POST", {"emoji": {"unicode": emoji}})

        if self.runtime and hasattr(self.runtime, "emit"):
            self.runtime.emit(
                GoogleChatEventTypes.REACTION_SENT,
                {"messageName": message_name, "emoji": emoji, "reactionName": result.get("name")},
            )

        return {"success": True, "name": result.get("name")}

    async def delete_reaction(self, reaction_name: str) -> dict:
        """Delete a reaction."""
        token = await self.get_access_token()
        session = await self._get_session()
        url = f"{CHAT_API_BASE}/{reaction_name}"

        async with session.delete(
            url,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if not response.ok:
                text = await response.text()
                return {"success": False, "error": f"Failed to delete reaction: {text or response.reason}"}

        return {"success": True}

    async def list_reactions(
        self, message_name: str, limit: int | None = None
    ) -> list[GoogleChatReaction]:
        """List reactions on a message."""
        url = f"{CHAT_API_BASE}/{message_name}/reactions"
        if limit and limit > 0:
            url += f"?pageSize={limit}"

        result = await self._fetch_api(url)

        reactions = []
        for r_data in result.get("reactions", []):
            reaction = GoogleChatReaction(
                name=r_data.get("name"),
                emoji=r_data.get("emoji", {}).get("unicode"),
            )
            if r_data.get("user"):
                from .types import GoogleChatUser

                reaction.user = GoogleChatUser(
                    name=r_data["user"].get("name", ""),
                    display_name=r_data["user"].get("displayName"),
                    email=r_data["user"].get("email"),
                    type=r_data["user"].get("type"),
                )
            reactions.append(reaction)

        return reactions

    async def find_direct_message(self, user_name: str) -> GoogleChatSpace | None:
        """Find or create a DM space with a user."""
        url = f"{CHAT_API_BASE}/spaces:findDirectMessage?name={user_name}"
        result = await self._fetch_api(url)

        if not result:
            return None

        return GoogleChatSpace(
            name=result.get("name", ""),
            display_name=result.get("displayName"),
            type=result.get("type", "DM"),
        )

    async def upload_attachment(
        self,
        space: str,
        filename: str,
        buffer: bytes,
        content_type: str | None = None,
    ) -> dict:
        """Upload an attachment to a space."""
        boundary = f"elizaos-{uuid.uuid4()}"
        metadata = json.dumps({"filename": filename})

        body_parts = [
            f"--{boundary}\r\n".encode(),
            b"Content-Type: application/json; charset=UTF-8\r\n\r\n",
            metadata.encode(),
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode(),
            buffer,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        body = b"".join(body_parts)

        token = await self.get_access_token()
        session = await self._get_session()
        url = f"{CHAT_UPLOAD_BASE}/{space}/attachments:upload?uploadType=multipart"

        async with session.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            data=body,
        ) as response:
            if not response.ok:
                text = await response.text()
                raise GoogleChatApiError(
                    f"Failed to upload attachment: {text or response.reason}",
                    response.status,
                )

            payload = await response.json()

        return {
            "attachmentUploadToken": payload.get("attachmentDataRef", {}).get(
                "attachmentUploadToken"
            )
        }

    async def download_media(
        self, resource_name: str, max_bytes: int | None = None
    ) -> dict:
        """Download media from a resource name."""
        url = f"{CHAT_API_BASE}/media/{resource_name}?alt=media"
        token = await self.get_access_token()
        session = await self._get_session()

        async with session.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if not response.ok:
                text = await response.text()
                raise GoogleChatApiError(
                    f"Failed to download media: {text or response.reason}",
                    response.status,
                )

            content_length = response.headers.get("content-length")
            if max_bytes and content_length:
                length = int(content_length)
                if length > max_bytes:
                    raise GoogleChatApiError(f"Media exceeds max bytes ({max_bytes})", 413)

            buffer = await response.read()
            content_type = response.headers.get("content-type")

        return {"buffer": buffer, "content_type": content_type}

    def get_settings(self) -> GoogleChatSettings | None:
        """Get the settings."""
        return self.settings

    async def process_webhook_event(self, event: GoogleChatEvent) -> None:
        """Process a webhook event."""
        event_type = event.type

        if not self.runtime or not hasattr(self.runtime, "emit"):
            return

        if event_type == "MESSAGE":
            self.runtime.emit(
                GoogleChatEventTypes.MESSAGE_RECEIVED,
                {
                    "event": event,
                    "message": event.message,
                    "space": event.space,
                    "user": event.user,
                },
            )
        elif event_type == "ADDED_TO_SPACE":
            self.runtime.emit(
                GoogleChatEventTypes.SPACE_JOINED,
                {"space": event.space, "user": event.user},
            )
        elif event_type == "REMOVED_FROM_SPACE":
            self.runtime.emit(
                GoogleChatEventTypes.SPACE_LEFT,
                {"space": event.space, "user": event.user},
            )
