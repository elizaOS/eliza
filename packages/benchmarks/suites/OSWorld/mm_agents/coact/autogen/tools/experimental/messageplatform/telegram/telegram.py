# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Annotated, Any, Union

from .....doc_utils import export_module
from .....import_utils import optional_import_block, require_optional_import
from .... import Tool
from ....dependency_injection import Depends, on

__all__ = ["TelegramRetrieveTool", "TelegramSendTool"]

with optional_import_block():
    from telethon import TelegramClient
    from telethon.tl.types import InputMessagesFilterEmpty, Message, PeerChannel, PeerChat, PeerUser

MAX_MESSAGE_LENGTH = 4096


@require_optional_import(["telethon", "telethon.tl.types"], "commsagent-telegram")
@export_module("autogen.tools.experimental")
class BaseTelegramTool:
    """Base class for Telegram tools containing shared functionality."""

    def __init__(self, api_id: str, api_hash: str, session_name: str) -> None:
        self._api_id = api_id
        self._api_hash = api_hash
        self._session_name = session_name

    def _get_client(self) -> "TelegramClient":  # type: ignore[no-any-unimported]
        """Get a fresh TelegramClient instance."""
        return TelegramClient(self._session_name, self._api_id, self._api_hash)

    @staticmethod
    def _get_peer_from_id(chat_id: str) -> Union["PeerChat", "PeerChannel", "PeerUser"]:  # type: ignore[no-any-unimported]
        """Convert a chat ID string to appropriate Peer type."""
        try:
            # Convert string to integer
            id_int = int(chat_id)

            # Channel/Supergroup: -100 prefix
            if str(chat_id).startswith("-100"):
                channel_id = int(str(chat_id)[4:])  # Remove -100 prefix
                return PeerChannel(channel_id)

            # Group: negative number without -100 prefix
            elif id_int < 0:
                group_id = -id_int  # Remove the negative sign
                return PeerChat(group_id)

            # User/Bot: positive number
            else:
                return PeerUser(id_int)

        except ValueError as e:
            raise ValueError(f"Invalid chat_id format: {chat_id}. Error: {str(e)}")

    async def _initialize_entity(self, client: "TelegramClient", chat_id: str) -> Any:  # type: ignore[no-any-unimported]
        """Initialize and cache the entity by trying different methods."""
        peer = self._get_peer_from_id(chat_id)

        try:
            # Try direct entity resolution first
            entity = await client.get_entity(peer)
            return entity
        except ValueError:
            try:
                # Get all dialogs (conversations)
                async for dialog in client.iter_dialogs():
                    # For users/bots, we need to find the dialog with the user
                    if (
                        isinstance(peer, PeerUser)
                        and dialog.entity.id == peer.user_id
                        or dialog.entity.id == getattr(peer, "channel_id", getattr(peer, "chat_id", None))
                    ):
                        return dialog.entity

                # If we get here, we didn't find the entity in dialogs
                raise ValueError(f"Could not find entity {chat_id} in dialogs")
            except Exception as e:
                raise ValueError(
                    f"Could not initialize entity for {chat_id}. "
                    f"Make sure you have access to this chat. Error: {str(e)}"
                )


@require_optional_import(["telethon"], "commsagent-telegram")
@export_module("autogen.tools.experimental")
class TelegramSendTool(BaseTelegramTool, Tool):
    """Sends a message to a Telegram channel, group, or user."""

    def __init__(self, *, api_id: str, api_hash: str, chat_id: str) -> None:
        """
        Initialize the TelegramSendTool.

        Args:
            api_id: Telegram API ID from https://my.telegram.org/apps.
            api_hash: Telegram API hash from https://my.telegram.org/apps.
            chat_id: The ID of the destination (Channel, Group, or User ID).
        """
        BaseTelegramTool.__init__(self, api_id, api_hash, "telegram_send_session")

        async def telegram_send_message(
            message: Annotated[str, "Message to send to the chat."],
            chat_id: Annotated[str, Depends(on(chat_id))],
        ) -> Any:
            """
            Sends a message to a Telegram chat.

            Args:
                message: The message to send.
                chat_id: The ID of the destination. (uses dependency injection)
            """
            try:
                client = self._get_client()
                async with client:
                    # Initialize and cache the entity
                    entity = await self._initialize_entity(client, chat_id)

                    if len(message) > MAX_MESSAGE_LENGTH:
                        chunks = [
                            message[i : i + (MAX_MESSAGE_LENGTH - 1)]
                            for i in range(0, len(message), (MAX_MESSAGE_LENGTH - 1))
                        ]
                        first_message: Union[Message, None] = None  # type: ignore[no-any-unimported]

                        for i, chunk in enumerate(chunks):
                            sent = await client.send_message(
                                entity=entity,
                                message=chunk,
                                parse_mode="html",
                                reply_to=first_message.id if first_message else None,
                            )

                            # Store the first message to chain replies
                            if i == 0:
                                first_message = sent
                                sent_message_id = str(sent.id)

                        return (
                            f"Message sent successfully ({len(chunks)} chunks, first ID: {sent_message_id}):\n{message}"
                        )
                    else:
                        sent = await client.send_message(entity=entity, message=message, parse_mode="html")
                        return f"Message sent successfully (ID: {sent.id}):\n{message}"

            except Exception as e:
                return f"Message send failed, exception: {str(e)}"

        Tool.__init__(
            self,
            name="telegram_send",
            description="Sends a message to a personal channel, bot channel, group, or channel.",
            func_or_tool=telegram_send_message,
        )


@require_optional_import(["telethon"], "commsagent-telegram")
@export_module("autogen.tools.experimental")
class TelegramRetrieveTool(BaseTelegramTool, Tool):
    """Retrieves messages from a Telegram channel."""

    def __init__(self, *, api_id: str, api_hash: str, chat_id: str) -> None:
        """
        Initialize the TelegramRetrieveTool.

        Args:
            api_id: Telegram API ID from https://my.telegram.org/apps.
            api_hash: Telegram API hash from https://my.telegram.org/apps.
            chat_id: The ID of the chat to retrieve messages from (Channel, Group, Bot Chat ID).
        """
        BaseTelegramTool.__init__(self, api_id, api_hash, "telegram_retrieve_session")
        self._chat_id = chat_id

        async def telegram_retrieve_messages(
            chat_id: Annotated[str, Depends(on(chat_id))],
            messages_since: Annotated[
                Union[str, None],
                "Date to retrieve messages from (ISO format) OR message ID. If None, retrieves latest messages.",
            ] = None,
            maximum_messages: Annotated[
                Union[int, None], "Maximum number of messages to retrieve. If None, retrieves all messages since date."
            ] = None,
            search: Annotated[Union[str, None], "Optional string to search for in messages."] = None,
        ) -> Any:
            """
            Retrieves messages from a Telegram chat.

            Args:
                chat_id: The ID of the chat. (uses dependency injection)
                messages_since: ISO format date string OR message ID to retrieve messages from.
                maximum_messages: Maximum number of messages to retrieve.
                search: Optional string to search for in messages.
            """
            try:
                client = self._get_client()
                async with client:
                    # Initialize and cache the entity
                    entity = await self._initialize_entity(client, chat_id)

                    # Setup retrieval parameters
                    params = {
                        "entity": entity,
                        "limit": maximum_messages if maximum_messages else None,
                        "search": search if search else None,
                        "filter": InputMessagesFilterEmpty(),
                        "wait_time": None,  # No wait time between requests
                    }

                    # Handle messages_since parameter
                    if messages_since:
                        try:
                            # Try to parse as message ID first
                            msg_id = int(messages_since)
                            params["min_id"] = msg_id
                        except ValueError:
                            # Not a message ID, try as ISO date
                            try:
                                date = datetime.fromisoformat(messages_since.replace("Z", "+00:00"))
                                params["offset_date"] = date
                                params["reverse"] = (
                                    True  # Need this because the date gets messages before a certain date by default
                                )
                            except ValueError:
                                return {
                                    "error": "Invalid messages_since format. Please provide either a message ID or ISO format date (e.g., '2025-01-25T00:00:00Z')"
                                }

                    # Retrieve messages
                    messages = []
                    count = 0
                    # For bot users, we need to get both sent and received messages
                    if isinstance(self._get_peer_from_id(chat_id), PeerUser):
                        print(f"Retrieving messages for bot chat {chat_id}")

                    async for message in client.iter_messages(**params):
                        count += 1
                        messages.append({
                            "id": str(message.id),
                            "date": message.date.isoformat(),
                            "from_id": str(message.from_id) if message.from_id else None,
                            "text": message.text,
                            "reply_to_msg_id": str(message.reply_to_msg_id) if message.reply_to_msg_id else None,
                            "forward_from": str(message.forward.from_id) if message.forward else None,
                            "edit_date": message.edit_date.isoformat() if message.edit_date else None,
                            "media": bool(message.media),
                            "entities": [
                                {"type": e.__class__.__name__, "offset": e.offset, "length": e.length}
                                for e in message.entities
                            ]
                            if message.entities
                            else None,
                        })

                        # Check if we've hit the maximum
                        if maximum_messages and len(messages) >= maximum_messages:
                            break

                    return {
                        "message_count": len(messages),
                        "messages": messages,
                        "start_time": messages_since or "latest",
                    }

            except Exception as e:
                return f"Message retrieval failed, exception: {str(e)}"

        Tool.__init__(
            self,
            name="telegram_retrieve",
            description="Retrieves messages from a Telegram chat based on datetime/message ID and/or number of latest messages.",
            func_or_tool=telegram_retrieve_messages,
        )
