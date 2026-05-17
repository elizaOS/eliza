# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime, timedelta
from typing import Annotated, Any, Optional, Tuple, Union

from .....doc_utils import export_module
from .....import_utils import optional_import_block, require_optional_import
from .... import Tool
from ....dependency_injection import Depends, on

__all__ = ["SlackSendTool"]

with optional_import_block():
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError

MAX_MESSAGE_LENGTH = 40000


@require_optional_import(["slack_sdk"], "commsagent-slack")
@export_module("autogen.tools.experimental")
class SlackSendTool(Tool):
    """Sends a message to a Slack channel."""

    def __init__(self, *, bot_token: str, channel_id: str) -> None:
        """
        Initialize the SlackSendTool.

        Args:
            bot_token: Bot User OAuth Token starting with "xoxb-".
            channel_id: Channel ID where messages will be sent.
        """

        # Function that sends the message, uses dependency injection for bot token / channel / guild
        async def slack_send_message(
            message: Annotated[str, "Message to send to the channel."],
            bot_token: Annotated[str, Depends(on(bot_token))],
            channel_id: Annotated[str, Depends(on(channel_id))],
        ) -> Any:
            """
            Sends a message to a Slack channel.

            Args:
                message: The message to send to the channel.
                bot_token: The bot token to use for Slack. (uses dependency injection)
                channel_id: The ID of the channel. (uses dependency injection)
            """
            try:
                web_client = WebClient(token=bot_token)

                # Send the message
                if len(message) > MAX_MESSAGE_LENGTH:
                    chunks = [
                        message[i : i + (MAX_MESSAGE_LENGTH - 1)]
                        for i in range(0, len(message), (MAX_MESSAGE_LENGTH - 1))
                    ]
                    for i, chunk in enumerate(chunks):
                        response = web_client.chat_postMessage(channel=channel_id, text=chunk)

                        if not response["ok"]:
                            return f"Message send failed on chunk {i + 1}, Slack response error: {response['error']}"

                        # Store ID for the first chunk
                        if i == 0:
                            sent_message_id = response["ts"]

                    return f"Message sent successfully ({len(chunks)} chunks, first ID: {sent_message_id}):\n{message}"
                else:
                    response = web_client.chat_postMessage(channel=channel_id, text=message)

                    if not response["ok"]:
                        return f"Message send failed, Slack response error: {response['error']}"

                    return f"Message sent successfully (ID: {response['ts']}):\n{message}"
            except SlackApiError as e:
                return f"Message send failed, Slack API exception: {e.response['error']} (See https://api.slack.com/automation/cli/errors#{e.response['error']})"
            except Exception as e:
                return f"Message send failed, exception: {e}"

        super().__init__(
            name="slack_send",
            description="Sends a message to a Slack channel.",
            func_or_tool=slack_send_message,
        )


@require_optional_import(["slack_sdk"], "commsagent-slack")
@export_module("autogen.tools.experimental")
class SlackRetrieveTool(Tool):
    """Retrieves messages from a Slack channel."""

    def __init__(self, *, bot_token: str, channel_id: str) -> None:
        """
        Initialize the SlackRetrieveTool.

        Args:
            bot_token: Bot User OAuth Token starting with "xoxb-".
            channel_id: Channel ID where messages will be sent.
        """

        async def slack_retrieve_messages(
            bot_token: Annotated[str, Depends(on(bot_token))],
            channel_id: Annotated[str, Depends(on(channel_id))],
            messages_since: Annotated[
                Union[str, None],
                "Date to retrieve messages from (ISO format) OR Slack message ID. If None, retrieves latest messages.",
            ] = None,
            maximum_messages: Annotated[
                Union[int, None], "Maximum number of messages to retrieve. If None, retrieves all messages since date."
            ] = None,
        ) -> Any:
            """
            Retrieves messages from a Discord channel.

            Args:
                bot_token: The bot token to use for Discord. (uses dependency injection)
                channel_id: The ID of the channel. (uses dependency injection)
                messages_since: ISO format date string OR Slack message ID, to retrieve messages from. If None, retrieves latest messages.
                maximum_messages: Maximum number of messages to retrieve. If None, retrieves all messages since date.
            """
            try:
                web_client = WebClient(token=bot_token)

                # Convert ISO datetime to Unix timestamp if needed
                oldest = None
                if messages_since:
                    if "." in messages_since:  # Likely a Slack message ID
                        oldest = messages_since
                    else:  # Assume ISO format
                        try:
                            dt = datetime.fromisoformat(messages_since.replace("Z", "+00:00"))
                            oldest = str(dt.timestamp())
                        except ValueError as e:
                            return f"Invalid date format. Please provide either a Slack message ID or ISO format date (e.g., '2025-01-25T00:00:00Z'). Error: {e}"

                messages = []
                cursor = None

                while True:
                    try:
                        # Prepare API call parameters
                        params = {
                            "channel": channel_id,
                            "limit": min(1000, maximum_messages) if maximum_messages else 1000,
                        }
                        if oldest:
                            params["oldest"] = oldest
                        if cursor:
                            params["cursor"] = cursor

                        # Make API call
                        response = web_client.conversations_history(**params)  # type: ignore[arg-type]

                        if not response["ok"]:
                            return f"Message retrieval failed, Slack response error: {response['error']}"

                        # Add messages to our list
                        messages.extend(response["messages"])

                        # Check if we've hit our maximum
                        if maximum_messages and len(messages) >= maximum_messages:
                            messages = messages[:maximum_messages]
                            break

                        # Check if there are more messages
                        if not response["has_more"]:
                            break

                        cursor = response["response_metadata"]["next_cursor"]

                    except SlackApiError as e:
                        return f"Message retrieval failed on pagination, Slack API error: {e.response['error']}"

                return {
                    "message_count": len(messages),
                    "messages": messages,
                    "start_time": oldest or "latest",
                }

            except SlackApiError as e:
                return f"Message retrieval failed, Slack API exception: {e.response['error']} (See https://api.slack.com/automation/cli/errors#{e.response['error']})"
            except Exception as e:
                return f"Message retrieval failed, exception: {e}"

        super().__init__(
            name="slack_retrieve",
            description="Retrieves messages from a Slack channel based datetime/message ID and/or number of latest messages.",
            func_or_tool=slack_retrieve_messages,
        )


@require_optional_import(["slack_sdk"], "commsagent-slack")
@export_module("autogen.tools.experimental")
class SlackRetrieveRepliesTool(Tool):
    """Retrieves replies to a specific Slack message from both threads and the channel."""

    def __init__(self, *, bot_token: str, channel_id: str) -> None:
        """
        Initialize the SlackRetrieveRepliesTool.

        Args:
            bot_token: Bot User OAuth Token starting with "xoxb-".
            channel_id: Channel ID where the parent message exists.
        """

        async def slack_retrieve_replies(
            message_ts: Annotated[str, "Timestamp (ts) of the parent message to retrieve replies for."],
            bot_token: Annotated[str, Depends(on(bot_token))],
            channel_id: Annotated[str, Depends(on(channel_id))],
            min_replies: Annotated[
                Optional[int],
                "Minimum number of replies to wait for before returning (thread + channel). If None, returns immediately.",
            ] = None,
            timeout_seconds: Annotated[
                int, "Maximum time in seconds to wait for the requested number of replies."
            ] = 60,
            poll_interval: Annotated[int, "Time in seconds between polling attempts when waiting for replies."] = 5,
            include_channel_messages: Annotated[
                bool, "Whether to include messages in the channel after the original message."
            ] = True,
        ) -> Any:
            """
            Retrieves replies to a specific Slack message, from both threads and the main channel.

            Args:
                message_ts: The timestamp (ts) identifier of the parent message.
                bot_token: The bot token to use for Slack. (uses dependency injection)
                channel_id: The ID of the channel. (uses dependency injection)
                min_replies: Minimum number of combined replies to wait for before returning. If None, returns immediately.
                timeout_seconds: Maximum time in seconds to wait for the requested number of replies.
                poll_interval: Time in seconds between polling attempts when waiting for replies.
                include_channel_messages: Whether to include messages posted in the channel after the original message.
            """
            try:
                web_client = WebClient(token=bot_token)

                # Function to get current thread replies
                async def get_thread_replies() -> tuple[Optional[list[dict[str, Any]]], Optional[str]]:
                    try:
                        response = web_client.conversations_replies(
                            channel=channel_id,
                            ts=message_ts,
                        )

                        if not response["ok"]:
                            return None, f"Thread reply retrieval failed, Slack response error: {response['error']}"

                        # The first message is the parent message itself, so exclude it when counting replies
                        replies = response["messages"][1:] if len(response["messages"]) > 0 else []
                        return replies, None

                    except SlackApiError as e:
                        return None, f"Thread reply retrieval failed, Slack API exception: {e.response['error']}"
                    except Exception as e:
                        return None, f"Thread reply retrieval failed, exception: {e}"

                # Function to get messages in the channel after the original message
                async def get_channel_messages() -> Tuple[Optional[list[dict[str, Any]]], Optional[str]]:
                    try:
                        response = web_client.conversations_history(
                            channel=channel_id,
                            oldest=message_ts,  # Start from the original message timestamp
                            inclusive=False,  # Don't include the original message
                        )

                        if not response["ok"]:
                            return None, f"Channel message retrieval failed, Slack response error: {response['error']}"

                        # Return all messages in the channel after the original message
                        # We need to filter out any that are part of the thread we're already getting
                        messages = []
                        for msg in response["messages"]:
                            # Skip if the message is part of the thread we're already retrieving
                            if "thread_ts" in msg and msg["thread_ts"] == message_ts:
                                continue
                            messages.append(msg)

                        return messages, None

                    except SlackApiError as e:
                        return None, f"Channel message retrieval failed, Slack API exception: {e.response['error']}"
                    except Exception as e:
                        return None, f"Channel message retrieval failed, exception: {e}"

                # Function to get all replies (both thread and channel)
                async def get_all_replies() -> Tuple[
                    Optional[list[dict[str, Any]]], Optional[list[dict[str, Any]]], Optional[str]
                ]:
                    thread_replies, thread_error = await get_thread_replies()
                    if thread_error:
                        return None, None, thread_error

                    channel_messages: list[dict[str, Any]] = []
                    channel_error = None

                    if include_channel_messages:
                        channel_results, channel_error = await get_channel_messages()
                        if channel_error:
                            return thread_replies, None, channel_error
                        channel_messages = channel_results if channel_results is not None else []

                    return thread_replies, channel_messages, None

                # If no waiting is required, just get replies and return
                if min_replies is None:
                    thread_replies, channel_messages, error = await get_all_replies()
                    if error:
                        return error

                    thread_replies_list: list[dict[str, Any]] = [] if thread_replies is None else thread_replies
                    channel_messages_list: list[dict[str, Any]] = [] if channel_messages is None else channel_messages

                    # Combine replies for counting but keep them separate in the result
                    total_reply_count = len(thread_replies_list) + len(channel_messages_list)

                    return {
                        "parent_message_ts": message_ts,
                        "total_reply_count": total_reply_count,
                        "thread_replies": thread_replies_list,
                        "thread_reply_count": len(thread_replies_list),
                        "channel_messages": channel_messages_list if include_channel_messages else None,
                        "channel_message_count": len(channel_messages_list) if include_channel_messages else None,
                    }

                # Wait for the required number of replies with timeout
                start_time = datetime.now()
                end_time = start_time + timedelta(seconds=timeout_seconds)

                while datetime.now() < end_time:
                    thread_replies, channel_messages, error = await get_all_replies()
                    if error:
                        return error

                    thread_replies_current: list[dict[str, Any]] = [] if thread_replies is None else thread_replies
                    channel_messages_current: list[dict[str, Any]] = (
                        [] if channel_messages is None else channel_messages
                    )

                    # Combine replies for counting
                    total_reply_count = len(thread_replies_current) + len(channel_messages_current)

                    # If we have enough total replies, return them
                    if total_reply_count >= min_replies:
                        return {
                            "parent_message_ts": message_ts,
                            "total_reply_count": total_reply_count,
                            "thread_replies": thread_replies_current,
                            "thread_reply_count": len(thread_replies_current),
                            "channel_messages": channel_messages_current if include_channel_messages else None,
                            "channel_message_count": len(channel_messages_current)
                            if include_channel_messages
                            else None,
                            "waited_seconds": (datetime.now() - start_time).total_seconds(),
                        }

                    # Wait before checking again
                    await asyncio.sleep(poll_interval)

                # If we reach here, we timed out waiting for replies
                thread_replies, channel_messages, error = await get_all_replies()
                if error:
                    return error

                # Combine replies for counting
                total_reply_count = len(thread_replies or []) + len(channel_messages or [])

                return {
                    "parent_message_ts": message_ts,
                    "total_reply_count": total_reply_count,
                    "thread_replies": thread_replies or [],
                    "thread_reply_count": len(thread_replies or []),
                    "channel_messages": channel_messages or [] if include_channel_messages else None,
                    "channel_message_count": len(channel_messages or []) if include_channel_messages else None,
                    "timed_out": True,
                    "waited_seconds": timeout_seconds,
                    "requested_replies": min_replies,
                }

            except SlackApiError as e:
                return f"Reply retrieval failed, Slack API exception: {e.response['error']} (See https://api.slack.com/automation/cli/errors#{e.response['error']})"
            except Exception as e:
                return f"Reply retrieval failed, exception: {e}"

        super().__init__(
            name="slack_retrieve_replies",
            description="Retrieves replies to a specific Slack message, checking both thread replies and messages in the channel after the original message.",
            func_or_tool=slack_retrieve_replies,
        )
