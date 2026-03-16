"""
Leave channel action for Twitch plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_twitch.types import (
    normalize_channel,
    TWITCH_SERVICE_NAME,
)


LEAVE_CHANNEL_TEMPLATE = """You are helping to extract a Twitch channel name.

The user wants to leave a Twitch channel.

Recent conversation:
{recent_messages}

Currently joined channels: {joined_channels}

Extract the channel name to leave (without the # prefix).

Respond with a JSON object like:
{{
  "channel": "channelname"
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
    """Handle the leave channel action."""
    twitch_service = runtime.get_service(TWITCH_SERVICE_NAME)

    if not twitch_service or not twitch_service.is_connected():
        if callback:
            await callback({"text": "Twitch service is not available.", "source": "twitch"})
        return {"success": False, "error": "Twitch service not available"}

    joined_channels = twitch_service.get_joined_channels()

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = LEAVE_CHANNEL_TEMPLATE.format(
        recent_messages=recent_messages,
        joined_channels=", ".join(joined_channels),
    )

    # Extract channel name using LLM
    channel_name = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        try:
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("channel"):
                    channel_name = normalize_channel(str(parsed["channel"]))
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not channel_name:
        if callback:
            await callback({
                "text": "I couldn't understand which channel you want me to leave. Please specify the channel name.",
                "source": "twitch",
            })
        return {"success": False, "error": "Could not extract channel name"}

    # Check if we're in that channel
    if channel_name not in joined_channels:
        if callback:
            await callback({
                "text": f"Not currently in channel #{channel_name}.",
                "source": "twitch",
            })
        return {"success": False, "error": "Not in that channel"}

    # Prevent leaving primary channel
    if channel_name == twitch_service.get_primary_channel():
        if callback:
            await callback({
                "text": f"Cannot leave the primary channel #{channel_name}.",
                "source": "twitch",
            })
        return {"success": False, "error": "Cannot leave primary channel"}

    # Leave channel
    await twitch_service.leave_channel(channel_name)

    if callback:
        await callback({
            "text": f"Left channel #{channel_name}.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "channel": channel_name,
        },
    }


leave_channel_action = {
    "name": "TWITCH_LEAVE_CHANNEL",
    "similes": [
        "LEAVE_TWITCH_CHANNEL",
        "EXIT_CHANNEL",
        "PART_CHANNEL",
        "DISCONNECT_CHANNEL",
    ],
    "description": "Leave a Twitch channel",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Leave the channel shroud"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll leave that channel.",
                    "actions": ["TWITCH_LEAVE_CHANNEL"],
                },
            },
        ]
    ],
}
