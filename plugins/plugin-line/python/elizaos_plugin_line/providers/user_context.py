"""
User context provider for the LINE plugin.
"""


from ..types import LINE_SERVICE_NAME


async def get_user_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the current LINE user context."""
    if message.content.get("source") != "line":
        return {"data": {}, "values": {}, "text": ""}

    line_service = runtime.get_service(LINE_SERVICE_NAME)

    if not line_service or not line_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"
    state_data = state.get("data", {}) if state else {}

    user_id = state_data.get("userId")

    if not user_id:
        return {"data": {"connected": True}, "values": {"connected": True}, "text": ""}

    # Get user profile
    profile = await line_service.get_user_profile(user_id)

    if not profile:
        return {
            "data": {"connected": True, "user_id": user_id},
            "values": {"user_id": user_id},
            "text": f"{agent_name} is talking to a LINE user (ID: {user_id[:8]}...).",
        }

    response_text = f"{agent_name} is talking to {profile.display_name} on LINE. "
    if profile.status_message:
        response_text += f'Their status: "{profile.status_message}". '
    if profile.language:
        response_text += f"Language preference: {profile.language}."

    return {
        "data": {
            "user_id": profile.user_id,
            "display_name": profile.display_name,
            "picture_url": profile.picture_url,
            "status_message": profile.status_message,
            "language": profile.language,
            "connected": True,
        },
        "values": {
            "user_id": profile.user_id,
            "display_name": profile.display_name,
            "language": profile.language,
        },
        "text": response_text,
    }


user_context_provider = {
    "name": "lineUserContext",
    "description": "Provides information about the LINE user in the current conversation",
    "get": get_user_context,
}
