"""
Channel state provider for Twitch plugin.
"""

from typing import Optional

from elizaos_plugin_twitch.types import (
    format_channel_for_display,
    normalize_channel,
    TWITCH_SERVICE_NAME,
)


async def get_channel_state(
    runtime,
    message,
    state: Optional[dict] = None,
):
    """Get the current Twitch channel state."""
    # Only provide context for Twitch messages
    if message.content.get("source") != "twitch":
        return {
            "data": {},
            "values": {},
            "text": "",
        }

    twitch_service = runtime.get_service(TWITCH_SERVICE_NAME)

    if not twitch_service or not twitch_service.is_connected():
        return {
            "data": {"connected": False},
            "values": {"connected": False},
            "text": "",
        }

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    # Get room from state if available
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room", {})
    channel_id = room.get("channel_id")
    channel = (
        normalize_channel(channel_id) if channel_id else twitch_service.get_primary_channel()
    )

    joined_channels = twitch_service.get_joined_channels()
    is_primary_channel = channel == twitch_service.get_primary_channel()
    bot_username = twitch_service.get_bot_username()

    response_text = f"{agent_name} is currently in Twitch channel {format_channel_for_display(channel)}."

    if is_primary_channel:
        response_text += " This is the primary channel."

    response_text += f"\n\nTwitch is a live streaming platform. Chat messages are public and visible to all viewers."
    response_text += f" {agent_name} is logged in as @{bot_username}."
    response_text += f" Currently connected to {len(joined_channels)} channel(s)."

    return {
        "data": {
            "channel": channel,
            "display_channel": format_channel_for_display(channel),
            "is_primary_channel": is_primary_channel,
            "bot_username": bot_username,
            "joined_channels": joined_channels,
            "channel_count": len(joined_channels),
            "connected": True,
        },
        "values": {
            "channel": channel,
            "display_channel": format_channel_for_display(channel),
            "is_primary_channel": is_primary_channel,
            "bot_username": bot_username,
            "channel_count": len(joined_channels),
        },
        "text": response_text,
    }


channel_state_provider = {
    "name": "twitchChannelState",
    "description": "Provides information about the current Twitch channel context",
    "get": get_channel_state,
}
