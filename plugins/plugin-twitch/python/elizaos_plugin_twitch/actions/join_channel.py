"""
Join channel action for Twitch plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_twitch.types import (
    normalize_channel,
    TWITCH_SERVICE_NAME,
)


JOIN_CHANNEL_TEMPLATE = """You are helping to extract a Twitch channel name.

The user wants to join a Twitch channel.

Recent conversation:
{recent_messages}

Extract the channel name to join (without the # prefix).

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
    """Handle the join channel action."""
    twitch_service = runtime.get_service(TWITCH_SERVICE_NAME)

    if not twitch_service or not twitch_service.is_connected():
        if callback:
            await callback({"text": "Twitch service is not available.", "source": "twitch"})
        return {"success": False, "error": "Twitch service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = JOIN_CHANNEL_TEMPLATE.format(recent_messages=recent_messages)

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
                "text": "I couldn't understand which channel you want me to join. Please specify the channel name.",
                "source": "twitch",
            })
        return {"success": False, "error": "Could not extract channel name"}

    # Check if already joined
    joined_channels = twitch_service.get_joined_channels()
    if channel_name in joined_channels:
        if callback:
            await callback({
                "text": f"Already in channel #{channel_name}.",
                "source": "twitch",
            })
        return {"success": True, "data": {"channel": channel_name, "already_joined": True}}

    # Join channel
    await twitch_service.join_channel(channel_name)

    if callback:
        await callback({
            "text": f"Joined channel #{channel_name}.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "channel": channel_name,
        },
    }


join_channel_action = {
    "name": "TWITCH_JOIN_CHANNEL",
    "similes": [
        "JOIN_TWITCH_CHANNEL",
        "ENTER_CHANNEL",
        "CONNECT_CHANNEL",
    ],
    "description": "Join a Twitch channel to listen and send messages",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Join the channel shroud"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll join that channel.",
                    "actions": ["TWITCH_JOIN_CHANNEL"],
                },
            },
        ]
    ],
}
