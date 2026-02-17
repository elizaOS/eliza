"""
Matrix service implementation for elizaOS.

This service provides Matrix messaging capabilities using matrix-nio.
"""

import asyncio
import logging
from typing import Optional

from nio import (
    AsyncClient,
    InviteMemberEvent,
    JoinError,
    MatrixRoom as NioRoom,
    RoomMessageText,
    SyncResponse,
)

from elizaos_plugin_matrix.types import (
    MatrixConfigurationError,
    MatrixEventTypes,
    MatrixMessage,
    MatrixMessageSendOptions,
    MatrixNotConnectedError,
    MatrixRoom,
    MatrixSendResult,
    MatrixSettings,
    MatrixUserInfo,
    get_matrix_localpart,
    is_valid_matrix_room_alias,
    MATRIX_SERVICE_NAME,
)

logger = logging.getLogger(__name__)


class MatrixService:
    """Matrix messaging service for elizaOS agents."""

    service_type: str = MATRIX_SERVICE_NAME

    def __init__(self, runtime):
        """Initialize the Matrix service."""
        self.runtime = runtime
        self.settings: Optional[MatrixSettings] = None
        self.client: Optional[AsyncClient] = None
        self._connected: bool = False
        self._syncing: bool = False
        self._sync_task: Optional[asyncio.Task] = None

    @classmethod
    async def start(cls, runtime) -> "MatrixService":
        """Start the Matrix service."""
        service = cls(runtime)
        await service._initialize()
        return service

    async def stop(self) -> None:
        """Stop the Matrix service."""
        if self._sync_task:
            self._sync_task.cancel()
            try:
                await self._sync_task
            except asyncio.CancelledError:
                pass

        if self.client:
            await self.client.close()

        self._connected = False
        logger.info("Matrix service stopped")

    async def _initialize(self) -> None:
        """Initialize the Matrix service with configuration."""
        self.settings = self._load_settings()
        self._validate_settings()

        self.client = AsyncClient(
            self.settings.homeserver,
            self.settings.user_id,
        )
        self.client.access_token = self.settings.access_token
        self.client.device_id = self.settings.device_id

        # Set up callbacks
        self.client.add_event_callback(self._on_message, RoomMessageText)
        self.client.add_event_callback(self._on_invite, InviteMemberEvent)

        # Start sync loop
        self._sync_task = asyncio.create_task(self._sync_loop())

        # Wait for initial sync
        for _ in range(30):
            if self._syncing:
                break
            await asyncio.sleep(1)

        if not self._syncing:
            raise MatrixConfigurationError("Failed to sync with Matrix homeserver")

        # Join configured rooms
        for room in self.settings.rooms:
            try:
                await self.join_room(room)
            except Exception as e:
                logger.warning(f"Failed to join room {room}: {e}")

        self._connected = True
        logger.info(f"Matrix service initialized for {self.settings.user_id}")

    def _load_settings(self) -> MatrixSettings:
        """Load settings from runtime."""
        homeserver = self.runtime.get_setting("MATRIX_HOMESERVER") or ""
        user_id = self.runtime.get_setting("MATRIX_USER_ID") or ""
        access_token = self.runtime.get_setting("MATRIX_ACCESS_TOKEN") or ""
        device_id = self.runtime.get_setting("MATRIX_DEVICE_ID")
        rooms_str = self.runtime.get_setting("MATRIX_ROOMS")
        auto_join_str = self.runtime.get_setting("MATRIX_AUTO_JOIN")
        encryption_str = self.runtime.get_setting("MATRIX_ENCRYPTION")
        require_mention_str = self.runtime.get_setting("MATRIX_REQUIRE_MENTION")

        rooms = (
            [r.strip() for r in rooms_str.split(",") if r.strip()]
            if rooms_str
            else []
        )

        return MatrixSettings(
            homeserver=homeserver,
            user_id=user_id,
            access_token=access_token,
            device_id=device_id,
            rooms=rooms,
            auto_join=auto_join_str == "true",
            encryption=encryption_str == "true",
            require_mention=require_mention_str == "true",
        )

    def _validate_settings(self) -> None:
        """Validate the settings."""
        if not self.settings:
            raise MatrixConfigurationError("Settings not loaded")

        if not self.settings.homeserver:
            raise MatrixConfigurationError(
                "MATRIX_HOMESERVER is required", "MATRIX_HOMESERVER"
            )

        if not self.settings.user_id:
            raise MatrixConfigurationError(
                "MATRIX_USER_ID is required", "MATRIX_USER_ID"
            )

        if not self.settings.access_token:
            raise MatrixConfigurationError(
                "MATRIX_ACCESS_TOKEN is required", "MATRIX_ACCESS_TOKEN"
            )

    async def _sync_loop(self) -> None:
        """Run the sync loop."""
        try:
            sync_filter = {
                "room": {
                    "timeline": {"limit": 10},
                    "state": {"lazy_load_members": True},
                }
            }

            while True:
                try:
                    response = await self.client.sync(
                        timeout=30000,
                        sync_filter=sync_filter,
                    )

                    if isinstance(response, SyncResponse):
                        if not self._syncing:
                            self._syncing = True
                            logger.info("Matrix sync complete")
                            if hasattr(self.runtime, "emit_event"):
                                await self.runtime.emit_event(
                                    MatrixEventTypes.SYNC_COMPLETE.value, {}
                                )

                except Exception as e:
                    logger.error(f"Sync error: {e}")
                    await asyncio.sleep(5)

        except asyncio.CancelledError:
            pass

    async def _on_message(self, room: NioRoom, event: RoomMessageText) -> None:
        """Handle incoming messages."""
        if not self.settings:
            return

        # Ignore own messages
        if event.sender == self.settings.user_id:
            return

        # Check mention requirement
        if self.settings.require_mention:
            localpart = get_matrix_localpart(self.settings.user_id)
            if localpart.lower() not in event.body.lower():
                return

        sender_info = MatrixUserInfo(
            user_id=event.sender,
            display_name=room.user_name(event.sender),
        )

        message = MatrixMessage(
            event_id=event.event_id,
            room_id=room.room_id,
            sender=event.sender,
            sender_info=sender_info,
            content=event.body,
            msg_type="m.text",
            formatted_body=getattr(event, "formatted_body", None),
            timestamp=event.server_timestamp,
        )

        matrix_room = MatrixRoom(
            room_id=room.room_id,
            name=room.display_name,
            topic=room.topic,
            canonical_alias=room.canonical_alias,
            is_encrypted=room.encrypted,
            is_direct=room.is_group,
            member_count=room.member_count,
        )

        logger.debug(
            f"Matrix message from {sender_info.display_name} in {room.display_name}: "
            f"{message.content[:50]}..."
        )

        if hasattr(self.runtime, "emit_event"):
            await self.runtime.emit_event(
                MatrixEventTypes.MESSAGE_RECEIVED.value,
                {"message": message, "room": matrix_room, "runtime": self.runtime},
            )

    async def _on_invite(self, room: NioRoom, event: InviteMemberEvent) -> None:
        """Handle room invites."""
        if not self.settings:
            return

        if event.state_key != self.settings.user_id:
            return

        if self.settings.auto_join:
            logger.info(f"Auto-joining room {room.room_id}")
            await self.join_room(room.room_id)

    def is_connected(self) -> bool:
        """Check if the service is connected."""
        return self._connected and self._syncing

    def get_user_id(self) -> str:
        """Get the user ID."""
        return self.settings.user_id if self.settings else ""

    def get_homeserver(self) -> str:
        """Get the homeserver URL."""
        return self.settings.homeserver if self.settings else ""

    async def get_joined_rooms(self) -> list[MatrixRoom]:
        """Get joined rooms."""
        if not self.client:
            return []

        rooms = []
        for room_id, room in self.client.rooms.items():
            rooms.append(
                MatrixRoom(
                    room_id=room_id,
                    name=room.display_name,
                    topic=room.topic,
                    canonical_alias=room.canonical_alias,
                    is_encrypted=room.encrypted,
                    is_direct=room.is_group,
                    member_count=room.member_count,
                )
            )
        return rooms

    async def send_message(
        self,
        text: str,
        options: Optional[MatrixMessageSendOptions] = None,
    ) -> MatrixSendResult:
        """Send a message to a room."""
        if not self.is_connected() or not self.client:
            raise MatrixNotConnectedError()

        opts = options or MatrixMessageSendOptions()
        room_id = opts.room_id

        if not room_id:
            return MatrixSendResult(success=False, error="Room ID is required")

        # Resolve room alias
        if is_valid_matrix_room_alias(room_id):
            response = await self.client.room_resolve_alias(room_id)
            if hasattr(response, "room_id"):
                room_id = response.room_id
            else:
                return MatrixSendResult(success=False, error="Could not resolve room alias")

        # Build content
        content = {
            "msgtype": "m.text",
            "body": text,
        }

        if opts.formatted:
            content["format"] = "org.matrix.custom.html"
            content["formatted_body"] = text

        # Handle reply/thread
        if opts.thread_id or opts.reply_to:
            content["m.relates_to"] = {}
            if opts.thread_id:
                content["m.relates_to"]["rel_type"] = "m.thread"
                content["m.relates_to"]["event_id"] = opts.thread_id
            if opts.reply_to:
                content["m.relates_to"]["m.in_reply_to"] = {
                    "event_id": opts.reply_to
                }

        response = await self.client.room_send(
            room_id=room_id,
            message_type="m.room.message",
            content=content,
        )

        if hasattr(response, "event_id"):
            if hasattr(self.runtime, "emit_event"):
                await self.runtime.emit_event(
                    MatrixEventTypes.MESSAGE_SENT.value,
                    {"room_id": room_id, "event_id": response.event_id, "content": text},
                )
            return MatrixSendResult(
                success=True,
                event_id=response.event_id,
                room_id=room_id,
            )

        return MatrixSendResult(success=False, error="Failed to send message")

    async def send_reaction(
        self,
        room_id: str,
        event_id: str,
        emoji: str,
    ) -> MatrixSendResult:
        """Send a reaction to a message."""
        if not self.is_connected() or not self.client:
            raise MatrixNotConnectedError()

        content = {
            "m.relates_to": {
                "rel_type": "m.annotation",
                "event_id": event_id,
                "key": emoji,
            }
        }

        response = await self.client.room_send(
            room_id=room_id,
            message_type="m.reaction",
            content=content,
        )

        if hasattr(response, "event_id"):
            return MatrixSendResult(
                success=True,
                event_id=response.event_id,
                room_id=room_id,
            )

        return MatrixSendResult(success=False, error="Failed to send reaction")

    async def join_room(self, room_id_or_alias: str) -> str:
        """Join a room."""
        if not self.is_connected() or not self.client:
            raise MatrixNotConnectedError()

        response = await self.client.join(room_id_or_alias)

        if isinstance(response, JoinError):
            raise Exception(f"Failed to join room: {response.message}")

        room_id = response.room_id
        logger.info(f"Joined room {room_id}")

        if hasattr(self.runtime, "emit_event"):
            await self.runtime.emit_event(
                MatrixEventTypes.ROOM_JOINED.value,
                {"room": {"room_id": room_id}},
            )

        return room_id

    async def leave_room(self, room_id: str) -> None:
        """Leave a room."""
        if not self.is_connected() or not self.client:
            raise MatrixNotConnectedError()

        await self.client.room_leave(room_id)
        logger.info(f"Left room {room_id}")

        if hasattr(self.runtime, "emit_event"):
            await self.runtime.emit_event(
                MatrixEventTypes.ROOM_LEFT.value,
                {"room_id": room_id},
            )

    async def send_typing(
        self,
        room_id: str,
        typing: bool,
        timeout: int = 30000,
    ) -> None:
        """Send typing indicator."""
        if not self.is_connected() or not self.client:
            return

        await self.client.room_typing(room_id, typing, timeout)

    async def send_read_receipt(self, room_id: str, event_id: str) -> None:
        """Send read receipt."""
        if not self.is_connected() or not self.client:
            return

        await self.client.room_read_markers(room_id, event_id, event_id)
