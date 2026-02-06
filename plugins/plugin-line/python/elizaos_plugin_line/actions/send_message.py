"""
Send message action for the LINE plugin.
"""

import json
import logging
import re

from ..types import (
    LINE_SERVICE_NAME,
    is_valid_line_id,
    normalize_line_target,
)

logger = logging.getLogger(__name__)

SEND_MESSAGE_TEMPLATE = """# Task: Extract LINE message parameters

Based on the conversation, determine what message to send and to whom.

Recent conversation:
{recent_messages}

Extract the following:
1. text: The message content to send
2. to: The target user/group/room ID (or "current" to reply to the current chat)

Respond with a JSON object:
```json
{{
  "text": "message to send",
  "to": "target ID or 'current'"
}}
```
"""


async def validate(runtime, message, state: dict | None = None) -> bool:
    """Validate if this action should run."""
    return message.content.get("source") == "line"


async def handler(
    runtime,
    message,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
):
    """Handle the send message action."""
    line_service = runtime.get_service(LINE_SERVICE_NAME)

    if not line_service or not line_service.is_connected():
        if callback:
            await callback({"text": "LINE service is not available.", "source": "line"})
        return {"success": False, "error": "LINE service not available"}

    # Extract parameters using LLM
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_MESSAGE_TEMPLATE.format(recent_messages=recent_messages)

    msg_info = None

    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    msg_info = {
                        "text": str(parsed["text"]),
                        "to": str(parsed.get("to", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not msg_info or not msg_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send.",
                "source": "line",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target
    target_id = None

    if msg_info["to"] and msg_info["to"] != "current":
        normalized = normalize_line_target(msg_info["to"])
        if normalized and is_valid_line_id(normalized):
            target_id = normalized

    # Fall back to current chat
    if not target_id:
        state_data = state.get("data", {}) if state else {}
        target_id = (
            state_data.get("groupId")
            or state_data.get("roomId")
            or state_data.get("userId")
        )

    if not target_id:
        if callback:
            await callback({
                "text": "I couldn't determine where to send the message.",
                "source": "line",
            })
        return {"success": False, "error": "Could not determine target"}

    # Send message
    result = await line_service.send_message(target_id, msg_info["text"])

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send message: {result.error}",
                "source": "line",
            })
        return {"success": False, "error": result.error}

    logger.debug(f"Sent LINE message to {target_id}")

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "to": target_id,
            "message_id": result.message_id,
        },
    }


send_message_action = {
    "name": "LINE_SEND_MESSAGE",
    "similes": ["SEND_LINE_MESSAGE", "LINE_MESSAGE", "LINE_TEXT", "MESSAGE_LINE"],
    "description": "Send a text message via LINE",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send them a message saying 'Hello!'"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that message via LINE.",
                    "actions": ["LINE_SEND_MESSAGE"],
                },
            },
        ],
    ],
}
