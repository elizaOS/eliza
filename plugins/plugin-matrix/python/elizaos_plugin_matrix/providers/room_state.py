"""
Room state provider for Matrix plugin.
"""

from typing import Optional

from elizaos_plugin_matrix.types import (
    get_matrix_localpart,
    MATRIX_SERVICE_NAME,
)


async def get_room_state(
    runtime,
    message,
    state: Optional[dict] = None,
):
    """Get the current Matrix room state."""
    if message.content.get("source") != "matrix":
        return {"data": {}, "values": {}, "text": ""}

    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room", {})
    room_id = room.get("room_id")
    room_name = room.get("name")
    is_encrypted = room.get("is_encrypted", False)
    is_direct = room.get("is_direct", False)
    member_count = room.get("member_count", 0)

    user_id = matrix_service.get_user_id()
    display_name = get_matrix_localpart(user_id)

    if is_direct:
        response_text = f"{agent_name} is in a direct message conversation on Matrix."
    else:
        room_label = room_name or room_id or "a Matrix room"
        response_text = f'{agent_name} is currently in Matrix room "{room_label}".'
        if member_count:
            response_text += f" The room has {member_count} members."

    if is_encrypted:
        response_text += " This room has end-to-end encryption enabled."

    response_text += f"\n\nMatrix is a decentralized communication protocol. {agent_name} is logged in as {user_id}."

    return {
        "data": {
            "room_id": room_id,
            "room_name": room_name,
            "is_encrypted": is_encrypted,
            "is_direct": is_direct,
            "member_count": member_count,
            "user_id": user_id,
            "display_name": display_name,
            "homeserver": matrix_service.get_homeserver(),
            "connected": True,
        },
        "values": {
            "room_id": room_id,
            "room_name": room_name,
            "is_encrypted": is_encrypted,
            "is_direct": is_direct,
            "member_count": member_count,
            "user_id": user_id,
        },
        "text": response_text,
    }


room_state_provider = {
    "name": "matrixRoomState",
    "description": "Provides information about the current Matrix room context",
    "get": get_room_state,
}
