"""
Space state provider for Google Chat plugin.
"""


from ..types import GOOGLE_CHAT_SERVICE_NAME


async def get_space_state(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the current Google Chat space state."""
    if message.content.get("source") != "google-chat":
        return {"data": {}, "values": {}, "text": ""}

    gchat_service = runtime.get_service(GOOGLE_CHAT_SERVICE_NAME)

    if not gchat_service or not gchat_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    state_data = state.get("data", {}) if state else {}
    space = state_data.get("space", {})
    space_name = space.get("name")
    space_display_name = space.get("displayName")
    space_type = space.get("type")
    is_threaded = space.get("threaded", False)
    is_dm = space_type == "DM" or space.get("singleUserBotDm", False)

    if is_dm:
        response_text = f"{agent_name} is in a direct message conversation on Google Chat."
    else:
        label = space_display_name or space_name or "a Google Chat space"
        response_text = f'{agent_name} is currently in Google Chat space "{label}".'
        if is_threaded:
            response_text += " This space uses threaded conversations."

    response_text += "\n\nGoogle Chat is Google Workspace's team communication platform."

    return {
        "data": {
            "space_name": space_name,
            "space_display_name": space_display_name,
            "space_type": space_type,
            "is_threaded": is_threaded,
            "is_direct": is_dm,
            "connected": True,
        },
        "values": {
            "space_name": space_name,
            "space_display_name": space_display_name,
            "space_type": space_type,
            "is_threaded": is_threaded,
            "is_direct": is_dm,
        },
        "text": response_text,
    }


space_state_provider = {
    "name": "googleChatSpaceState",
    "description": "Provides information about the current Google Chat space context",
    "get": get_space_state,
}
