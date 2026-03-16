"""
User context provider for Twitch plugin.
"""

from typing import Optional

from elizaos_plugin_twitch.types import (
    get_twitch_user_display_name,
    TWITCH_SERVICE_NAME,
)


async def get_user_context(
    runtime,
    message,
    state: Optional[dict] = None,
):
    """Get the current Twitch user context."""
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
            "data": {},
            "values": {},
            "text": "",
        }

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    # Try to get user info from message metadata
    metadata = message.content.get("metadata", {})
    user_info = metadata.get("user")

    if not user_info:
        return {
            "data": {},
            "values": {},
            "text": "",
        }

    display_name = get_twitch_user_display_name(user_info)
    roles = []

    if user_info.is_broadcaster:
        roles.append("broadcaster")
    if user_info.is_moderator:
        roles.append("moderator")
    if user_info.is_vip:
        roles.append("VIP")
    if user_info.is_subscriber:
        roles.append("subscriber")

    role_text = ", ".join(roles) if roles else "viewer"

    response_text = f"{agent_name} is talking to {display_name} ({role_text}) in Twitch chat."

    if user_info.is_broadcaster:
        response_text += f" {display_name} is the channel owner/broadcaster."
    elif user_info.is_moderator:
        response_text += f" {display_name} is a channel moderator."

    return {
        "data": {
            "user_id": user_info.user_id,
            "username": user_info.username,
            "display_name": display_name,
            "is_broadcaster": user_info.is_broadcaster,
            "is_moderator": user_info.is_moderator,
            "is_vip": user_info.is_vip,
            "is_subscriber": user_info.is_subscriber,
            "roles": roles,
            "color": user_info.color,
        },
        "values": {
            "user_id": user_info.user_id,
            "username": user_info.username,
            "display_name": display_name,
            "role_text": role_text,
            "is_broadcaster": user_info.is_broadcaster,
            "is_moderator": user_info.is_moderator,
        },
        "text": response_text,
    }


user_context_provider = {
    "name": "twitchUserContext",
    "description": "Provides information about the Twitch user in the current conversation",
    "get": get_user_context,
}
