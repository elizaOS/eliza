"""
Send message action for Twitch plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_twitch.types import (
    TwitchMessageSendOptions,
    normalize_channel,
    TWITCH_SERVICE_NAME,
)


SEND_MESSAGE_TEMPLATE = """You are helping to extract send message parameters for Twitch chat.

The user wants to send a message to a Twitch channel.

Recent conversation:
{recent_messages}

Extract the following:
1. text: The message text to send
2. channel: The channel name to send to (without # prefix), or "current" for the current channel

Respond with a JSON object like:
{{
  "text": "The message to send",
  "channel": "current"
}}

Only respond with the JSON object, no other text."""


async def validate(runtime, message, state: Optional[dict] = None) -> bool:
    """Validate if this action can be executed."""
    return message.content.get("source") == "twitch"


async def handler(
    runtime,
    message,
    state: Optional[dict] = None,
    options: Optional[dict] = None,
    callback=None,
):
    """Handle the send message action."""
    twitch_service = runtime.get_service(TWITCH_SERVICE_NAME)

    if not twitch_service or not twitch_service.is_connected():
        if callback:
            await callback({"text": "Twitch service is not available.", "source": "twitch"})
        return {"success": False, "error": "Twitch service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_MESSAGE_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    message_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        try:
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    message_info = {
                        "text": str(parsed["text"]),
                        "channel": str(parsed.get("channel", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not message_info or not message_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send. Please try again.",
                "source": "twitch",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target channel
    target_channel = twitch_service.get_primary_channel()
    if message_info["channel"] and message_info["channel"] != "current":
        target_channel = normalize_channel(message_info["channel"])

    # Get channel from room context if available
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room", {})
    if room.get("channel_id"):
        target_channel = normalize_channel(room["channel_id"])

    # Send message
    options = TwitchMessageSendOptions(channel=target_channel)
    result = await twitch_service.send_message(message_info["text"], options)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send message: {result.error}",
                "source": "twitch",
            })
        return {"success": False, "error": result.error}

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "channel": target_channel,
            "message_id": result.message_id,
        },
    }


send_message_action = {
    "name": "TWITCH_SEND_MESSAGE",
    "similes": [
        "SEND_TWITCH_MESSAGE",
        "TWITCH_CHAT",
        "CHAT_TWITCH",
        "SAY_IN_TWITCH",
    ],
    "description": "Send a message to a Twitch channel",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Send a message to chat saying 'Hello everyone!'"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that message to the chat.",
                    "actions": ["TWITCH_SEND_MESSAGE"],
                },
            },
        ]
    ],
}
