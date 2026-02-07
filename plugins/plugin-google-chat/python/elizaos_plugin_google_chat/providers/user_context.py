"""
User context provider for Google Chat plugin.
"""


from ..types import (
    GOOGLE_CHAT_SERVICE_NAME,
    GoogleChatUser,
    extract_resource_id,
    get_user_display_name,
)


async def get_user_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the current Google Chat user context."""
    if message.content.get("source") != "google-chat":
        return {"data": {}, "values": {}, "text": ""}

    gchat_service = runtime.get_service(GOOGLE_CHAT_SERVICE_NAME)

    if not gchat_service or not gchat_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    # Get sender from state if available
    state_data = state.get("data", {}) if state else {}
    sender_data = state_data.get("sender", {})

    if not sender_data:
        return {"data": {"connected": True}, "values": {"connected": True}, "text": ""}

    # Reconstruct sender object
    sender = GoogleChatUser(
        name=sender_data.get("name", ""),
        display_name=sender_data.get("displayName"),
        email=sender_data.get("email"),
        type=sender_data.get("type"),
    )

    user_name = sender.name
    display_name = get_user_display_name(sender)
    user_id = extract_resource_id(user_name)
    email = sender.email
    user_type = sender.type

    response_text = f"{agent_name} is talking to {display_name}"
    if email:
        response_text += f" ({email})"
    response_text += " on Google Chat."

    if user_type == "BOT":
        response_text += " This user is a bot."

    return {
        "data": {
            "user_name": user_name,
            "user_id": user_id,
            "display_name": display_name,
            "email": email,
            "user_type": user_type or "HUMAN",
            "is_bot": user_type == "BOT",
        },
        "values": {
            "user_name": user_name,
            "user_id": user_id,
            "display_name": display_name,
            "email": email,
        },
        "text": response_text,
    }


user_context_provider = {
    "name": "googleChatUserContext",
    "description": "Provides information about the Google Chat user in the current conversation",
    "get": get_user_context,
}
