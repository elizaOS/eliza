"""
Send message action for the iMessage plugin.
"""

import json
import logging
import re

from ..types import (
    IMESSAGE_SERVICE_NAME,
    is_valid_imessage_target,
    normalize_imessage_target,
)

logger = logging.getLogger(__name__)

SEND_MESSAGE_TEMPLATE = """# Task: Extract iMessage parameters

Based on the conversation, determine what message to send and to whom.

Recent conversation:
{recent_messages}

Extract the following:
1. text: The message content to send
2. to: The recipient (phone number, email, or "current" to reply)

Respond with a JSON object:
```json
{{
  "text": "message to send",
  "to": "phone/email or 'current'"
}}
```
"""


async def validate(runtime, message, state: dict | None = None) -> bool:
    """Validate if this action should run."""
    return message.content.get("source") == "imessage"


async def handler(
    runtime,
    message,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
):
    """Handle the send message action."""
    imessage_service = runtime.get_service(IMESSAGE_SERVICE_NAME)

    if not imessage_service or not imessage_service.is_connected():
        if callback:
            await callback({"text": "iMessage service is not available.", "source": "imessage"})
        return {"success": False, "error": "iMessage service not available"}

    if not imessage_service.is_macos():
        if callback:
            await callback({"text": "iMessage is only available on macOS.", "source": "imessage"})
        return {"success": False, "error": "iMessage requires macOS"}

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
                "source": "imessage",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target
    target_id = None

    if msg_info["to"] and msg_info["to"] != "current":
        normalized = normalize_imessage_target(msg_info["to"])
        if normalized and is_valid_imessage_target(normalized):
            target_id = normalized

    # Fall back to current chat
    if not target_id:
        state_data = state.get("data", {}) if state else {}
        target_id = state_data.get("chatId") or state_data.get("handle")

    if not target_id:
        if callback:
            await callback({
                "text": "I couldn't determine who to send the message to.",
                "source": "imessage",
            })
        return {"success": False, "error": "Could not determine recipient"}

    # Send message
    result = await imessage_service.send_message(target_id, msg_info["text"])

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send message: {result.error}",
                "source": "imessage",
            })
        return {"success": False, "error": result.error}

    logger.debug(f"Sent iMessage to {target_id}")

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
    "name": "IMESSAGE_SEND_MESSAGE",
    "similes": ["SEND_IMESSAGE", "IMESSAGE_TEXT", "TEXT_IMESSAGE", "SEND_IMSG"],
    "description": "Send a text message via iMessage (macOS only)",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send them a message saying 'Hello!'"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that message via iMessage.",
                    "actions": ["IMESSAGE_SEND_MESSAGE"],
                },
            },
        ],
    ],
}
