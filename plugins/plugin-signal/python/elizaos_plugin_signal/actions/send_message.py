"""
Send message action for Signal plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_signal.types import (
    is_valid_group_id,
    normalize_e164,
    SIGNAL_SERVICE_NAME,
)


SEND_MESSAGE_TEMPLATE = """You are helping to extract send message parameters for Signal.

The user wants to send a message to a Signal contact or group.

Recent conversation:
{recent_messages}

Extract the following:
1. text: The message text to send
2. recipient: The phone number (E.164 format like +1234567890) or group ID to send to (default: "current" for current conversation)

Respond with a JSON object like:
{{
  "text": "The message to send",
  "recipient": "current"
}}

Only respond with the JSON object, no other text."""


async def validate(runtime, message, state: Optional[dict] = None) -> bool:
    """Validate if this action can be executed."""
    return message.content.get("source") == "signal"


async def handler(
    runtime,
    message,
    state: Optional[dict] = None,
    options: Optional[dict] = None,
    callback=None,
):
    """Handle the send message action."""
    signal_service = runtime.get_service(SIGNAL_SERVICE_NAME)

    if not signal_service or not signal_service.is_service_connected():
        if callback:
            await callback({"text": "Signal service is not available.", "source": "signal"})
        return {"success": False, "error": "Signal service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_MESSAGE_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    message_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})
        
        # Parse JSON from response
        try:
            # Find JSON in response
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    message_info = {
                        "text": str(parsed["text"]),
                        "recipient": str(parsed.get("recipient", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not message_info or not message_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send. Please try again with a clearer request.",
                "source": "signal",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Get room info
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room") or await runtime.get_room(message.room_id)

    if not room:
        if callback:
            await callback({
                "text": "I couldn't determine the current conversation.",
                "source": "signal",
            })
        return {"success": False, "error": "Could not determine conversation"}

    target_recipient = room.get("channel_id", "")
    is_group = room.get("metadata", {}).get("is_group", False)

    # Override recipient if specified
    if message_info["recipient"] and message_info["recipient"] != "current":
        normalized = normalize_e164(message_info["recipient"])
        if normalized:
            target_recipient = normalized
        elif is_valid_group_id(message_info["recipient"]):
            target_recipient = message_info["recipient"]

    # Send message
    if is_group or is_valid_group_id(target_recipient):
        result = await signal_service.send_group_message(
            target_recipient, message_info["text"]
        )
    else:
        result = await signal_service.send_message(
            target_recipient, message_info["text"]
        )

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "timestamp": result.get("timestamp"),
            "recipient": target_recipient,
        },
    }


send_message_action = {
    "name": "SIGNAL_SEND_MESSAGE",
    "similes": [
        "SEND_SIGNAL_MESSAGE",
        "TEXT_SIGNAL",
        "MESSAGE_SIGNAL",
        "SIGNAL_TEXT",
    ],
    "description": "Send a message to a Signal contact or group",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Send a message to +1234567890 saying 'Hello!'"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that message for you.",
                    "actions": ["SIGNAL_SEND_MESSAGE"],
                },
            },
        ]
    ],
}
