"""
Send reaction action for Matrix plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_matrix.types import MATRIX_SERVICE_NAME


SEND_REACTION_TEMPLATE = """You are helping to extract reaction parameters for Matrix.

The user wants to react to a Matrix message with an emoji.

Recent conversation:
{recent_messages}

Extract the following:
1. emoji: The emoji to react with (single emoji character)
2. eventId: The event ID of the message to react to (starts with $)

Respond with a JSON object like:
{{
  "emoji": "👍",
  "eventId": "$event123"
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
    """Handle the send reaction action."""
    matrix_service = runtime.get_service(MATRIX_SERVICE_NAME)

    if not matrix_service or not matrix_service.is_connected():
        if callback:
            await callback({"text": "Matrix service is not available.", "source": "matrix"})
        return {"success": False, "error": "Matrix service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_REACTION_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    reaction_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        try:
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("emoji") and parsed.get("eventId"):
                    reaction_info = {
                        "emoji": str(parsed["emoji"]),
                        "event_id": str(parsed["eventId"]),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not reaction_info:
        if callback:
            await callback({
                "text": "I couldn't understand the reaction request.",
                "source": "matrix",
            })
        return {"success": False, "error": "Could not extract reaction parameters"}

    # Get room from state
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room", {})
    room_id = room.get("room_id")

    if not room_id:
        if callback:
            await callback({
                "text": "I couldn't determine which room this is in.",
                "source": "matrix",
            })
        return {"success": False, "error": "Could not determine room"}

    # Send reaction
    result = await matrix_service.send_reaction(
        room_id,
        reaction_info["event_id"],
        reaction_info["emoji"],
    )

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to add reaction: {result.error}",
                "source": "matrix",
            })
        return {"success": False, "error": result.error}

    if callback:
        await callback({
            "text": f"Added {reaction_info['emoji']} reaction.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "emoji": reaction_info["emoji"],
            "event_id": reaction_info["event_id"],
            "room_id": room_id,
        },
    }


send_reaction_action = {
    "name": "MATRIX_SEND_REACTION",
    "similes": ["REACT_MATRIX", "MATRIX_REACT", "ADD_MATRIX_REACTION"],
    "description": "React to a Matrix message with an emoji",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "React to the last message with 👍"}},
            {"name": "{{agent}}", "content": {"text": "I'll add a reaction.", "actions": ["MATRIX_SEND_REACTION"]}},
        ]
    ],
}
