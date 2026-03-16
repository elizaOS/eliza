"""
Join room action for Matrix plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_matrix.types import (
    is_valid_matrix_room_alias,
    is_valid_matrix_room_id,
    MATRIX_SERVICE_NAME,
)


JOIN_ROOM_TEMPLATE = """You are helping to extract a Matrix room identifier.

The user wants to join a Matrix room.

Recent conversation:
{recent_messages}

Extract the room ID (!room:server) or room alias (#alias:server) to join.

Respond with a JSON object like:
{{
  "room": "!room:matrix.org"
}}

Only respond with the JSON object, no other text."""


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
    """Handle the join room action."""
    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        if callback:
            await callback({"text": "Matrix service is not available.", "source": "matrix"})
        return {"success": False, "error": "Matrix service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = JOIN_ROOM_TEMPLATE.format(recent_messages=recent_messages)

    # Extract room using LLM
    room = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        try:
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("room"):
                    room_str = str(parsed["room"]).strip()
                    if is_valid_matrix_room_id(room_str) or is_valid_matrix_room_alias(room_str):
                        room = room_str
                        break
        except (json.JSONDecodeError, ValueError):
            continue

    if not room:
        if callback:
            await callback({
                "text": "I couldn't understand which room you want me to join.",
                "source": "matrix",
            })
        return {"success": False, "error": "Could not extract room identifier"}

    # Join room
    try:
        room_id = await matrix_service.join_room(room)

        if callback:
            await callback({
                "text": f"Joined room {room}.",
                "source": message.content.get("source"),
            })

        return {
            "success": True,
            "data": {
                "room_id": room_id,
                "joined": room,
            },
        }
    except Exception as e:
        error = str(e)
        if callback:
            await callback({
                "text": f"Failed to join room: {error}",
                "source": "matrix",
            })
        return {"success": False, "error": error}


join_room_action = {
    "name": "MATRIX_JOIN_ROOM",
    "similes": ["JOIN_MATRIX_ROOM", "ENTER_ROOM"],
    "description": "Join a Matrix room by ID or alias",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Join #general:matrix.org"}},
            {"name": "{{agent}}", "content": {"text": "I'll join that room.", "actions": ["MATRIX_JOIN_ROOM"]}},
        ]
    ],
}
