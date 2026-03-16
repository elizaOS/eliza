"""
Signal service implementation for elizaOS.

This service provides Signal messaging capabilities via the Signal CLI REST API.
"""

import asyncio
import json
import logging
from typing import Callable, Optional
from urllib.parse import urljoin

import aiohttp

from elizaos_plugin_signal.types import (
    SignalApiError,
    SignalClientNotAvailableError,
    SignalConfigurationError,
    SignalContact,
    SignalEventTypes,
    SignalGroup,
    SignalGroupMember,
    SignalMessage,
    SignalMessageSendOptions,
    SignalReactionInfo,
    SignalSettings,
    get_signal_contact_display_name,
    is_valid_e164,
    is_valid_group_id,
    normalize_e164,
    SIGNAL_SERVICE_NAME,
)

logger = logging.getLogger(__name__)


class SignalService:
    """
    Signal messaging service for elizaOS agents.

    Communicates with the Signal protocol via the Signal CLI REST API.
    """

    service_type: str = SIGNAL_SERVICE_NAME

    def __init__(self, runtime):
        """Initialize the Signal service."""
        self.runtime = runtime
        self.settings: Optional[SignalSettings] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._connected: bool = False
        self._polling: bool = False
        self._poll_task: Optional[asyncio.Task] = None

        # Caches
        self._contacts_cache: dict[str, SignalContact] = {}
        self._groups_cache: dict[str, SignalGroup] = {}

    @classmethod
    async def start(cls, runtime) -> "SignalService":
        """Start the Signal service."""
        service = cls(runtime)
        await service._initialize()
        return service

    async def stop(self) -> None:
        """Stop the Signal service."""
        self._polling = False
        
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

        if self._session:
            await self._session.close()
            self._session = None

        self._connected = False
        logger.info("Signal service stopped")

    async def _initialize(self) -> None:
        """Initialize the Signal service with configuration."""
        account_number = self.runtime.get_setting("SIGNAL_ACCOUNT_NUMBER")
        http_url = self.runtime.get_setting("SIGNAL_HTTP_URL")
        cli_path = self.runtime.get_setting("SIGNAL_CLI_PATH")
        ignore_groups = self.runtime.get_setting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES")

        if not account_number:
            raise SignalConfigurationError(
                "SIGNAL_ACCOUNT_NUMBER is required", "SIGNAL_ACCOUNT_NUMBER"
            )

        normalized = normalize_e164(account_number)
        if not normalized:
            raise SignalConfigurationError(
                f"Invalid phone number format: {account_number}. Must be E.164 format.",
                "SIGNAL_ACCOUNT_NUMBER",
            )

        if not http_url and not cli_path:
            raise SignalConfigurationError(
                "Either SIGNAL_HTTP_URL or SIGNAL_CLI_PATH must be provided"
            )

        self.settings = SignalSettings(
            account_number=normalized,
            http_url=http_url,
            cli_path=cli_path,
            should_ignore_group_messages=str(ignore_groups).lower() == "true",
        )

        # Create HTTP session if using REST API
        if self.settings.http_url:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=30),
                headers={"Content-Type": "application/json"},
            )

            # Test connection
            await self._verify_connection()

            # Load initial data
            await self._load_contacts()
            await self._load_groups()

            # Start message polling
            self._polling = True
            self._poll_task = asyncio.create_task(self._poll_messages())

        self._connected = True
        logger.info(
            f"Signal service initialized for account {self.settings.account_number}"
        )

    async def _verify_connection(self) -> None:
        """Verify the connection to the Signal API."""
        if not self._session or not self.settings:
            raise SignalClientNotAvailableError()

        url = urljoin(self.settings.http_url, "/v1/about")
        async with self._session.get(url) as response:
            if response.status != 200:
                raise SignalApiError(
                    f"Failed to connect to Signal API: {response.status}",
                    status_code=response.status,
                )

    async def _api_request(
        self,
        method: str,
        endpoint: str,
        data: Optional[dict] = None,
        params: Optional[dict] = None,
    ) -> dict:
        """Make an API request to the Signal CLI REST API."""
        if not self._session or not self.settings:
            raise SignalClientNotAvailableError()

        url = urljoin(self.settings.http_url, endpoint)

        async with self._session.request(
            method, url, json=data, params=params
        ) as response:
            body = await response.text()

            if response.status >= 400:
                raise SignalApiError(
                    f"Signal API error: {response.status}",
                    status_code=response.status,
                    response_body=body,
                )

            if body:
                return json.loads(body)
            return {}

    async def _load_contacts(self) -> None:
        """Load contacts from Signal."""
        if not self.settings:
            return

        result = await self._api_request(
            "GET", f"/v1/contacts/{self.settings.account_number}"
        )

        for contact_data in result:
            contact = SignalContact(
                number=contact_data.get("number", ""),
                uuid=contact_data.get("uuid"),
                name=contact_data.get("name"),
                profile_name=contact_data.get("profileName"),
                given_name=contact_data.get("givenName"),
                family_name=contact_data.get("familyName"),
                color=contact_data.get("color"),
                blocked=contact_data.get("blocked", False),
                message_expiration_time=contact_data.get("messageExpirationTime", 0),
            )
            self._contacts_cache[contact.number] = contact

        logger.debug(f"Loaded {len(self._contacts_cache)} contacts")

    async def _load_groups(self) -> None:
        """Load groups from Signal."""
        if not self.settings:
            return

        result = await self._api_request(
            "GET", f"/v1/groups/{self.settings.account_number}"
        )

        for group_data in result:
            members = [
                SignalGroupMember(
                    uuid=m.get("uuid", ""),
                    number=m.get("number"),
                    role=m.get("role", "DEFAULT"),
                )
                for m in group_data.get("members", [])
            ]

            admins = [
                SignalGroupMember(
                    uuid=m.get("uuid", ""),
                    number=m.get("number"),
                    role="ADMINISTRATOR",
                )
                for m in group_data.get("admins", [])
            ]

            group = SignalGroup(
                id=group_data.get("id", ""),
                name=group_data.get("name", ""),
                description=group_data.get("description"),
                members=members,
                admins=admins,
                is_blocked=group_data.get("blocked", False),
                is_member=group_data.get("isMember", True),
                message_expiration_time=group_data.get("messageExpirationTime", 0),
                invite_link=group_data.get("inviteLink"),
            )
            self._groups_cache[group.id] = group

        logger.debug(f"Loaded {len(self._groups_cache)} groups")

    async def _poll_messages(self) -> None:
        """Poll for new messages from Signal."""
        if not self.settings:
            return

        while self._polling:
            try:
                result = await self._api_request(
                    "GET",
                    f"/v1/receive/{self.settings.account_number}",
                    params={"timeout": "10"},
                )

                for envelope in result:
                    await self._handle_envelope(envelope)

            except SignalApiError as e:
                logger.warning(f"Error polling messages: {e}")
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Unexpected error polling messages: {e}")
                await asyncio.sleep(5)

            await asyncio.sleep(self.settings.poll_interval_ms / 1000)

    async def _handle_envelope(self, envelope: dict) -> None:
        """Handle an incoming Signal envelope."""
        if not self.settings:
            return

        source = envelope.get("source")
        source_uuid = envelope.get("sourceUuid")
        timestamp = envelope.get("timestamp", 0)

        # Skip messages from ourselves
        if source == self.settings.account_number:
            return

        data_message = envelope.get("dataMessage")
        if data_message:
            text = data_message.get("message")
            group_info = data_message.get("groupInfo")
            group_id = group_info.get("groupId") if group_info else None

            # Skip group messages if configured
            if group_id and self.settings.should_ignore_group_messages:
                return

            # Handle reaction
            reaction_data = data_message.get("reaction")
            if reaction_data:
                reaction = SignalReactionInfo(
                    emoji=reaction_data.get("emoji", ""),
                    target_author=reaction_data.get("targetAuthor", ""),
                    target_sent_timestamp=reaction_data.get("targetSentTimestamp", 0),
                    is_remove=reaction_data.get("isRemove", False),
                )
                await self._emit_event(
                    SignalEventTypes.REACTION_RECEIVED,
                    {
                        "source": source,
                        "source_uuid": source_uuid,
                        "timestamp": timestamp,
                        "group_id": group_id,
                        "reaction": reaction,
                    },
                )
                return

            # Regular message
            message = SignalMessage(
                timestamp=timestamp,
                source=source,
                source_uuid=source_uuid,
                text=text,
                group_id=group_id,
            )

            await self._emit_event(
                SignalEventTypes.MESSAGE_RECEIVED,
                {
                    "message": message,
                    "source": source,
                    "group_id": group_id,
                },
            )

    async def _emit_event(self, event_type: SignalEventTypes, data: dict) -> None:
        """Emit an event to the runtime."""
        if hasattr(self.runtime, "emit_event"):
            await self.runtime.emit_event(event_type.value, data)

    def is_service_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected

    def get_account_number(self) -> Optional[str]:
        """Get the configured account number."""
        return self.settings.account_number if self.settings else None

    def get_contact(self, number: str) -> Optional[SignalContact]:
        """Get a contact by phone number."""
        normalized = normalize_e164(number)
        return self._contacts_cache.get(normalized) if normalized else None

    def get_cached_group(self, group_id: str) -> Optional[SignalGroup]:
        """Get a group from cache."""
        return self._groups_cache.get(group_id)

    async def send_message(
        self,
        recipient: str,
        text: str,
        options: Optional[SignalMessageSendOptions] = None,
    ) -> dict:
        """Send a direct message to a recipient."""
        if not self.settings:
            raise SignalClientNotAvailableError()

        normalized = normalize_e164(recipient)
        if not normalized:
            raise ValueError(f"Invalid recipient phone number: {recipient}")

        data = {
            "message": text,
            "number": self.settings.account_number,
            "recipients": [normalized],
        }

        if options:
            if options.quote_timestamp and options.quote_author:
                data["quote"] = {
                    "id": options.quote_timestamp,
                    "author": options.quote_author,
                }
            if options.attachments:
                data["base64_attachments"] = options.attachments

        result = await self._api_request("POST", "/v2/send", data=data)

        timestamp = result.get("timestamp", 0)
        await self._emit_event(
            SignalEventTypes.MESSAGE_SENT,
            {"recipient": normalized, "text": text, "timestamp": timestamp},
        )

        return {"timestamp": timestamp}

    async def send_group_message(
        self,
        group_id: str,
        text: str,
        options: Optional[SignalMessageSendOptions] = None,
    ) -> dict:
        """Send a message to a group."""
        if not self.settings:
            raise SignalClientNotAvailableError()

        if not is_valid_group_id(group_id):
            raise ValueError(f"Invalid group ID: {group_id}")

        data = {
            "message": text,
            "number": self.settings.account_number,
            "recipients": [group_id],
        }

        if options:
            if options.quote_timestamp and options.quote_author:
                data["quote"] = {
                    "id": options.quote_timestamp,
                    "author": options.quote_author,
                }
            if options.attachments:
                data["base64_attachments"] = options.attachments

        result = await self._api_request("POST", "/v2/send", data=data)

        timestamp = result.get("timestamp", 0)
        await self._emit_event(
            SignalEventTypes.MESSAGE_SENT,
            {"group_id": group_id, "text": text, "timestamp": timestamp},
        )

        return {"timestamp": timestamp}

    async def send_reaction(
        self,
        recipient: str,
        emoji: str,
        target_timestamp: int,
        target_author: str,
    ) -> dict:
        """Send a reaction to a message."""
        if not self.settings:
            raise SignalClientNotAvailableError()

        data = {
            "recipient": recipient,
            "reaction": {
                "emoji": emoji,
                "target_author": target_author,
                "target_sent_timestamp": target_timestamp,
            },
        }

        await self._api_request(
            "POST",
            f"/v1/reactions/{self.settings.account_number}",
            data=data,
        )

        return {"success": True}

    async def remove_reaction(
        self,
        recipient: str,
        emoji: str,
        target_timestamp: int,
        target_author: str,
    ) -> dict:
        """Remove a reaction from a message."""
        if not self.settings:
            raise SignalClientNotAvailableError()

        data = {
            "recipient": recipient,
            "reaction": {
                "emoji": emoji,
                "target_author": target_author,
                "target_sent_timestamp": target_timestamp,
                "remove": True,
            },
        }

        await self._api_request(
            "POST",
            f"/v1/reactions/{self.settings.account_number}",
            data=data,
        )

        return {"success": True}

    async def send_typing_indicator(
        self, recipient: str, is_group: bool = False
    ) -> None:
        """Send a typing indicator."""
        if not self.settings or not self.settings.typing_indicator_enabled:
            return

        data = {"recipient": recipient}
        if is_group:
            data["group_id"] = recipient

        await self._api_request(
            "PUT",
            f"/v1/typing-indicator/{self.settings.account_number}",
            data=data,
        )

    async def stop_typing_indicator(
        self, recipient: str, is_group: bool = False
    ) -> None:
        """Stop a typing indicator."""
        if not self.settings or not self.settings.typing_indicator_enabled:
            return

        data = {"recipient": recipient}
        if is_group:
            data["group_id"] = recipient

        await self._api_request(
            "DELETE",
            f"/v1/typing-indicator/{self.settings.account_number}",
            data=data,
        )

    async def get_contacts(self) -> list[SignalContact]:
        """Get all contacts."""
        await self._load_contacts()
        return list(self._contacts_cache.values())

    async def get_groups(self) -> list[SignalGroup]:
        """Get all groups."""
        await self._load_groups()
        return list(self._groups_cache.values())

    async def get_group(self, group_id: str) -> Optional[SignalGroup]:
        """Get a specific group by ID."""
        if not self.settings:
            return None

        result = await self._api_request(
            "GET",
            f"/v1/groups/{self.settings.account_number}/{group_id}",
        )

        if result:
            members = [
                SignalGroupMember(
                    uuid=m.get("uuid", ""),
                    number=m.get("number"),
                    role=m.get("role", "DEFAULT"),
                )
                for m in result.get("members", [])
            ]

            group = SignalGroup(
                id=result.get("id", ""),
                name=result.get("name", ""),
                description=result.get("description"),
                members=members,
                is_blocked=result.get("blocked", False),
                is_member=result.get("isMember", True),
            )
            self._groups_cache[group.id] = group
            return group

        return None
