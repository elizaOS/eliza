"""
List channels action for Twitch plugin.
"""

from typing import Optional

from elizaos_plugin_twitch.types import (
    format_channel_for_display,
    TWITCH_SERVICE_NAME,
)


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
    """Handle the list channels action."""
    twitch_service = runtime.get_service(TWITCH_SERVICE_NAME)

    if not twitch_service or not twitch_service.is_connected():
        if callback:
            await callback({"text": "Twitch service is not available.", "source": "twitch"})
        return {"success": False, "error": "Twitch service not available"}

    joined_channels = twitch_service.get_joined_channels()
    primary_channel = twitch_service.get_primary_channel()

    # Format channel list
    channel_list = []
    for channel in joined_channels:
        display_name = format_channel_for_display(channel)
        is_primary = channel == primary_channel
        if is_primary:
            channel_list.append(f"{display_name} (primary)")
        else:
            channel_list.append(display_name)

    if joined_channels:
        response_text = (
            f"Currently in {len(joined_channels)} channel(s):\n"
            + "\n".join(f"• {c}" for c in channel_list)
        )
    else:
        response_text = "Not currently in any channels."

    if callback:
        await callback({
            "text": response_text,
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "channel_count": len(joined_channels),
            "channels": joined_channels,
            "primary_channel": primary_channel,
        },
    }


list_channels_action = {
    "name": "TWITCH_LIST_CHANNELS",
    "similes": [
        "LIST_TWITCH_CHANNELS",
        "SHOW_CHANNELS",
        "GET_CHANNELS",
        "CURRENT_CHANNELS",
    ],
    "description": "List all Twitch channels the bot is currently in",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "What channels are you in?"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll list the channels I'm currently in.",
                    "actions": ["TWITCH_LIST_CHANNELS"],
                },
            },
        ]
    ],
}
