"""
List rooms action for Matrix plugin.
"""

from typing import Optional

from elizaos_plugin_matrix.types import MATRIX_SERVICE_NAME


async def validate(runtime, message, state: Optional[dict] = None) -> bool:
    """Validate if this action can be executed."""
    return message.content.get("source") == "matrix"


async def handler(
    runtime,
    message,
    state: Optional[dict] = None,
    options: Optional[dict] = None,
    callback=None,
):
    """Handle the list rooms action."""
    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        if callback:
            await callback({"text": "Matrix service is not available.", "source": "matrix"})
        return {"success": False, "error": "Matrix service not available"}

    rooms = await matrix_service.get_joined_rooms()

    # Format room list
    room_list = []
    for room in rooms:
        name = room.name or room.canonical_alias or room.room_id
        members = f"{room.member_count} members"
        encrypted = " 🔒" if room.is_encrypted else ""
        room_list.append(f"• {name} ({members}){encrypted}")

    if rooms:
        response_text = f"Joined {len(rooms)} room(s):\n\n" + "\n".join(room_list)
    else:
        response_text = "Not currently in any rooms."

    if callback:
        await callback({
            "text": response_text,
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "room_count": len(rooms),
            "rooms": [
                {
                    "room_id": r.room_id,
                    "name": r.name,
                    "alias": r.canonical_alias,
                    "member_count": r.member_count,
                    "is_encrypted": r.is_encrypted,
                }
                for r in rooms
            ],
        },
    }


list_rooms_action = {
    "name": "MATRIX_LIST_ROOMS",
    "similes": ["LIST_MATRIX_ROOMS", "SHOW_ROOMS", "GET_ROOMS", "MY_ROOMS"],
    "description": "List all Matrix rooms the bot has joined",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "What rooms are you in?"}},
            {"name": "{{agent}}", "content": {"text": "I'll list my rooms.", "actions": ["MATRIX_LIST_ROOMS"]}},
        ]
    ],
}
