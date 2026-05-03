# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime, timezone
from typing import Annotated, Any, Union

from .....doc_utils import export_module
from .....import_utils import optional_import_block, require_optional_import
from .... import Tool
from ....dependency_injection import Depends, on

__all__ = ["DiscordRetrieveTool", "DiscordSendTool"]

with optional_import_block():
    from discord import Client, Intents, utils

MAX_MESSAGE_LENGTH = 2000
MAX_BATCH_RETRIEVE_MESSAGES = 100  # Discord's max per request


@require_optional_import(["discord"], "commsagent-discord")
@export_module("autogen.tools.experimental")
class DiscordSendTool(Tool):
    """Sends a message to a Discord channel."""

    def __init__(self, *, bot_token: str, channel_name: str, guild_name: str) -> None:
        """
        Initialize the DiscordSendTool.

        Args:
            bot_token: The bot token to use for sending messages.
            channel_name: The name of the channel to send messages to.
            guild_name: The name of the guild for the channel.
        """

        # Function that sends the message, uses dependency injection for bot token / channel / guild
        async def discord_send_message(
            message: Annotated[str, "Message to send to the channel."],
            bot_token: Annotated[str, Depends(on(bot_token))],
            guild_name: Annotated[str, Depends(on(guild_name))],
            channel_name: Annotated[str, Depends(on(channel_name))],
        ) -> Any:
            """
            Sends a message to a Discord channel.

            Args:
                message: The message to send to the channel.
                bot_token: The bot token to use for Discord. (uses dependency injection)
                guild_name: The name of the server. (uses dependency injection)
                channel_name: The name of the channel. (uses dependency injection)
            """
            intents = Intents.default()
            intents.message_content = True
            intents.guilds = True
            intents.guild_messages = True

            client = Client(intents=intents)
            result_future: asyncio.Future[str] = asyncio.Future()  # Stores the result of the send

            # When the client is ready, we'll send the message
            @client.event  # type: ignore[misc]
            async def on_ready() -> None:
                try:
                    # Server
                    guild = utils.get(client.guilds, name=guild_name)
                    if guild:
                        # Channel
                        channel = utils.get(guild.text_channels, name=channel_name)
                        if channel:
                            # Send the message
                            if len(message) > MAX_MESSAGE_LENGTH:
                                chunks = [
                                    message[i : i + (MAX_MESSAGE_LENGTH - 1)]
                                    for i in range(0, len(message), (MAX_MESSAGE_LENGTH - 1))
                                ]
                                for i, chunk in enumerate(chunks):
                                    sent = await channel.send(chunk)

                                    # Store ID for the first chunk
                                    if i == 0:
                                        sent_message_id = str(sent.id)

                                result_future.set_result(
                                    f"Message sent successfully ({len(chunks)} chunks, first ID: {sent_message_id}):\n{message}"
                                )
                            else:
                                sent = await channel.send(message)
                                result_future.set_result(f"Message sent successfully (ID: {sent.id}):\n{message}")
                        else:
                            result_future.set_result(f"Message send failed, could not find channel: {channel_name}")
                    else:
                        result_future.set_result(f"Message send failed, could not find guild: {guild_name}")

                except Exception as e:
                    result_future.set_exception(e)
                finally:
                    try:
                        await client.close()
                    except Exception as e:
                        raise Exception(f"Unable to close Discord client: {e}")

            # Start the client and when it's ready it'll send the message in on_ready
            try:
                await client.start(bot_token)

                # Capture the result of the send
                return await result_future
            except Exception as e:
                raise Exception(f"Failed to start Discord client: {e}")

        super().__init__(
            name="discord_send",
            description="Sends a message to a Discord channel.",
            func_or_tool=discord_send_message,
        )


@require_optional_import(["discord"], "commsagent-discord")
@export_module("autogen.tools.experimental")
class DiscordRetrieveTool(Tool):
    """Retrieves messages from a Discord channel."""

    def __init__(self, *, bot_token: str, channel_name: str, guild_name: str) -> None:
        """
        Initialize the DiscordRetrieveTool.

        Args:
            bot_token: The bot token to use for retrieving messages.
            channel_name: The name of the channel to retrieve messages from.
            guild_name: The name of the guild for the channel.
        """

        async def discord_retrieve_messages(
            bot_token: Annotated[str, Depends(on(bot_token))],
            guild_name: Annotated[str, Depends(on(guild_name))],
            channel_name: Annotated[str, Depends(on(channel_name))],
            messages_since: Annotated[
                Union[str, None],
                "Date to retrieve messages from (ISO format) OR Discord snowflake ID. If None, retrieves latest messages.",
            ] = None,
            maximum_messages: Annotated[
                Union[int, None], "Maximum number of messages to retrieve. If None, retrieves all messages since date."
            ] = None,
        ) -> Any:
            """
            Retrieves messages from a Discord channel.

            Args:
                bot_token: The bot token to use for Discord. (uses dependency injection)
                guild_name: The name of the server. (uses dependency injection)
                channel_name: The name of the channel. (uses dependency injection)
                messages_since: ISO format date string OR Discord snowflake ID, to retrieve messages from. If None, retrieves latest messages.
                maximum_messages: Maximum number of messages to retrieve. If None, retrieves all messages since date.
            """
            intents = Intents.default()
            intents.message_content = True
            intents.guilds = True
            intents.guild_messages = True

            client = Client(intents=intents)
            result_future: asyncio.Future[list[dict[str, Any]]] = asyncio.Future()

            messages_since_date: Union[str, None] = None
            if messages_since is not None:
                if DiscordRetrieveTool._is_snowflake(messages_since):
                    messages_since_date = DiscordRetrieveTool._snowflake_to_iso(messages_since)
                else:
                    messages_since_date = messages_since

            @client.event  # type: ignore[misc]
            async def on_ready() -> None:
                try:
                    messages = []

                    # Get guild and channel
                    guild = utils.get(client.guilds, name=guild_name)
                    if not guild:
                        result_future.set_result([{"error": f"Could not find guild: {guild_name}"}])
                        return

                    channel = utils.get(guild.text_channels, name=channel_name)
                    if not channel:
                        result_future.set_result([{"error": f"Could not find channel: {channel_name}"}])
                        return

                    # Setup retrieval parameters
                    last_message_id = None
                    messages_retrieved = 0

                    # Convert to ISO format
                    after_date = None
                    if messages_since_date:
                        try:
                            from datetime import datetime

                            after_date = datetime.fromisoformat(messages_since_date)
                        except ValueError:
                            result_future.set_result([
                                {"error": f"Invalid date format: {messages_since_date}. Use ISO format."}
                            ])
                            return

                    while True:
                        # Setup fetch options
                        fetch_options = {
                            "limit": MAX_BATCH_RETRIEVE_MESSAGES,
                            "before": last_message_id if last_message_id else None,
                            "after": after_date if after_date else None,
                        }

                        # Fetch batch of messages
                        message_batch = []
                        async for message in channel.history(**fetch_options):  # type: ignore[arg-type]
                            message_batch.append(message)
                            messages_retrieved += 1

                            # Check if we've reached the maximum
                            if maximum_messages and messages_retrieved >= maximum_messages:
                                break

                        if not message_batch:
                            break

                        # Process messages
                        for msg in message_batch:
                            messages.append({
                                "id": str(msg.id),
                                "content": msg.content,
                                "author": str(msg.author),
                                "timestamp": msg.created_at.isoformat(),
                            })

                        # Update last message ID for pagination
                        last_message_id = message_batch[-1]  # Use message object directly as 'before' parameter

                        # Break if we've reached the maximum
                        if maximum_messages and messages_retrieved >= maximum_messages:
                            break

                    result_future.set_result(messages)

                except Exception as e:
                    result_future.set_exception(e)
                finally:
                    try:
                        await client.close()
                    except Exception as e:
                        raise Exception(f"Unable to close Discord client: {e}")

            try:
                await client.start(bot_token)
                return await result_future
            except Exception as e:
                raise Exception(f"Failed to start Discord client: {e}")

        super().__init__(
            name="discord_retrieve",
            description="Retrieves messages from a Discord channel based datetime/message ID and/or number of latest messages.",
            func_or_tool=discord_retrieve_messages,
        )

    @staticmethod
    def _is_snowflake(value: str) -> bool:
        """Check if a string is a valid Discord snowflake ID."""
        # Must be numeric and 17-20 digits
        if not value.isdigit():
            return False

        digit_count = len(value)
        return 17 <= digit_count <= 20

    @staticmethod
    def _snowflake_to_iso(snowflake: str) -> str:
        """Convert a Discord snowflake ID to ISO timestamp string."""
        if not DiscordRetrieveTool._is_snowflake(snowflake):
            raise ValueError(f"Invalid snowflake ID: {snowflake}")

        # Discord epoch (2015-01-01)
        discord_epoch = 1420070400000

        # Convert ID to int and shift right 22 bits to get timestamp
        timestamp_ms = (int(snowflake) >> 22) + discord_epoch

        # Convert to datetime and format as ISO string
        dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
        return dt.isoformat()
