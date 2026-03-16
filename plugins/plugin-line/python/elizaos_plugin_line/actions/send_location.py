"""
Send location action for the LINE plugin.
"""

import json
import logging
import re

from ..types import (
    LINE_SERVICE_NAME,
    LineLocationMessage,
    is_valid_line_id,
    normalize_line_target,
)

logger = logging.getLogger(__name__)

SEND_LOCATION_TEMPLATE = """# Task: Extract LINE location message parameters

Based on the conversation, determine the location to send.

Recent conversation:
{recent_messages}

Extract the following:
1. title: Place name
2. address: Full address
3. latitude: Latitude coordinate (number)
4. longitude: Longitude coordinate (number)
5. to: The target user/group/room ID (or "current" to reply to the current chat)

Respond with a JSON object:
```json
{{
  "title": "Place Name",
  "address": "123 Main St, City",
  "latitude": 35.6762,
  "longitude": 139.6503,
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
    """Handle the send location action."""
    line_service = runtime.get_service(LINE_SERVICE_NAME)

    if not line_service or not line_service.is_connected():
        if callback:
            await callback({"text": "LINE service is not available.", "source": "line"})
        return {"success": False, "error": "LINE service not available"}

    # Extract parameters using LLM
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_LOCATION_TEMPLATE.format(recent_messages=recent_messages)

    location_info = None

    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if (
                    parsed.get("title")
                    and parsed.get("address")
                    and "latitude" in parsed
                    and "longitude" in parsed
                ):
                    location_info = {
                        "title": str(parsed["title"]),
                        "address": str(parsed["address"]),
                        "latitude": float(parsed["latitude"]),
                        "longitude": float(parsed["longitude"]),
                        "to": str(parsed.get("to", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not location_info:
        if callback:
            await callback({
                "text": "I couldn't understand the location information.",
                "source": "line",
            })
        return {"success": False, "error": "Could not extract location parameters"}

    # Determine target
    target_id = None

    if location_info["to"] and location_info["to"] != "current":
        normalized = normalize_line_target(location_info["to"])
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
                "text": "I couldn't determine where to send the location.",
                "source": "line",
            })
        return {"success": False, "error": "Could not determine target"}

    # Create location message
    location = LineLocationMessage(
        title=location_info["title"],
        address=location_info["address"],
        latitude=location_info["latitude"],
        longitude=location_info["longitude"],
    )

    # Send message
    result = await line_service.send_location_message(target_id, location)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send location: {result.error}",
                "source": "line",
            })
        return {"success": False, "error": result.error}

    logger.debug(f"Sent LINE location to {target_id}")

    if callback:
        await callback({
            "text": "Location sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "to": target_id,
            "message_id": result.message_id,
            "location": {
                "title": location.title,
                "address": location.address,
                "latitude": location.latitude,
                "longitude": location.longitude,
            },
        },
    }


send_location_action = {
    "name": "LINE_SEND_LOCATION",
    "similes": ["SEND_LINE_LOCATION", "LINE_LOCATION", "LINE_MAP", "SHARE_LOCATION_LINE"],
    "description": "Send a location message via LINE",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send them the location of Tokyo Tower"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send the location.",
                    "actions": ["LINE_SEND_LOCATION"],
                },
            },
        ],
    ],
}
