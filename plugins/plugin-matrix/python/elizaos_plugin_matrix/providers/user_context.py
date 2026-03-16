"""
User context provider for Matrix plugin.
"""

from typing import Optional

from elizaos_plugin_matrix.types import (
    get_matrix_localpart,
    get_matrix_user_display_name,
    MATRIX_SERVICE_NAME,
)


async def get_user_context(
    runtime,
    message,
    state: Optional[dict] = None,
):
    """Get the current Matrix user context."""
    if message.content.get("source") != "matrix":
        return {"data": {}, "values": {}, "text": ""}

    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        return {"data": {}, "values": {}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    metadata = message.content.get("metadata", {})
    sender_info = metadata.get("sender_info")

    if not sender_info:
        return {"data": {}, "values": {}, "text": ""}

    display_name = get_matrix_user_display_name(sender_info)
    localpart = get_matrix_localpart(sender_info.user_id)

    response_text = f"{agent_name} is talking to {display_name} ({sender_info.user_id}) on Matrix."

    return {
        "data": {
            "user_id": sender_info.user_id,
            "display_name": display_name,
            "localpart": localpart,
            "avatar_url": sender_info.avatar_url,
        },
        "values": {
            "user_id": sender_info.user_id,
            "display_name": display_name,
            "localpart": localpart,
        },
        "text": response_text,
    }


user_context_provider = {
    "name": "matrixUserContext",
    "description": "Provides information about the Matrix user in the current conversation",
    "get": get_user_context,
}
