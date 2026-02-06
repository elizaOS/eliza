"""
Send message action for Matrix plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_matrix.types import (
    MatrixMessageSendOptions,
    is_valid_matrix_room_alias,
    is_valid_matrix_room_id,
    MATRIX_SERVICE_NAME,
)


SEND_MESSAGE_TEMPLATE = """You are helping to extract send message parameters for Matrix.

The user wants to send a message to a Matrix room.

Recent conversation:
{recent_messages}

Extract the following:
1. text: The message text to send
2. roomId: The room ID (!room:server) or alias (#alias:server), or "current" for the current room

Respond with a JSON object like:
{{
  "text": "The message to send",
  "roomId": "current"
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
    """Handle the send message action."""
    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        if callback:
            await callback({"text": "Matrix service is not available.", "source": "matrix"})
        return {"success": False, "error": "Matrix service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_MESSAGE_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    message_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        try:
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    message_info = {
                        "text": str(parsed["text"]),
                        "room_id": str(parsed.get("roomId", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not message_info or not message_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send.",
                "source": "matrix",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target room
    target_room_id = None
    if message_info["room_id"] and message_info["room_id"] != "current":
        if is_valid_matrix_room_id(message_info["room_id"]) or is_valid_matrix_room_alias(message_info["room_id"]):
            target_room_id = message_info["room_id"]

    # Get room from state if available
    if not target_room_id:
        state_data = state.get("data", {}) if state else {}
        room = state_data.get("room", {})
        target_room_id = room.get("room_id")

    if not target_room_id:
        if callback:
            await callback({
                "text": "I couldn't determine which room to send to.",
                "source": "matrix",
            })
        return {"success": False, "error": "Could not determine target room"}

    # Send message
    opts = MatrixMessageSendOptions(room_id=target_room_id)
    result = await matrix_service.send_message(message_info["text"], opts)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send message: {result.error}",
                "source": "matrix",
            })
        return {"success": False, "error": result.error}

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "room_id": result.room_id,
            "event_id": result.event_id,
        },
    }


send_message_action = {
    "name": "MATRIX_SEND_MESSAGE",
    "similes": ["SEND_MATRIX_MESSAGE", "MESSAGE_MATRIX", "MATRIX_TEXT"],
    "description": "Send a message to a Matrix room",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send a message saying 'Hello everyone!'"}},
            {"name": "{{agent}}", "content": {"text": "I'll send that message.", "actions": ["MATRIX_SEND_MESSAGE"]}},
        ]
    ],
}
