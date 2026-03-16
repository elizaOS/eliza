"""
Send flex message action for the LINE plugin.
"""

import json
import logging
import re

from ..types import (
    LINE_SERVICE_NAME,
    LineFlexMessage,
    is_valid_line_id,
    normalize_line_target,
)

logger = logging.getLogger(__name__)

SEND_FLEX_TEMPLATE = """# Task: Extract LINE Flex message parameters

Based on the conversation, determine the flex message content to send.

Recent conversation:
{recent_messages}

Extract the following:
1. altText: Alternative text for notifications (short summary)
2. title: Card title
3. body: Card body text
4. to: The target user/group/room ID (or "current" to reply to the current chat)

Respond with a JSON object:
```json
{{
  "altText": "notification text",
  "title": "Card Title",
  "body": "Card body text",
  "to": "target ID or 'current'"
}}
```
"""


def create_info_bubble(title: str, body: str) -> dict:
    """Create a simple info card bubble."""
    return {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": title,
                    "weight": "bold",
                    "size": "xl",
                    "wrap": True,
                },
                {
                    "type": "text",
                    "text": body,
                    "margin": "md",
                    "wrap": True,
                },
            ],
        },
    }


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
    """Handle the send flex message action."""
    line_service = runtime.get_service(LINE_SERVICE_NAME)

    if not line_service or not line_service.is_connected():
        if callback:
            await callback({"text": "LINE service is not available.", "source": "line"})
        return {"success": False, "error": "LINE service not available"}

    # Extract parameters using LLM
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_FLEX_TEMPLATE.format(recent_messages=recent_messages)

    flex_info = None

    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("title") and parsed.get("body"):
                    flex_info = {
                        "alt_text": str(
                            parsed.get("altText", f"{parsed['title']}: {parsed['body']}")
                        ),
                        "title": str(parsed["title"]),
                        "body": str(parsed["body"]),
                        "to": str(parsed.get("to", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not flex_info or not flex_info.get("title"):
        if callback:
            await callback({
                "text": "I couldn't understand the flex message content.",
                "source": "line",
            })
        return {"success": False, "error": "Could not extract flex message parameters"}

    # Determine target
    target_id = None

    if flex_info["to"] and flex_info["to"] != "current":
        normalized = normalize_line_target(flex_info["to"])
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

    # Create flex message
    flex_message = LineFlexMessage(
        alt_text=flex_info["alt_text"][:400],
        contents=create_info_bubble(flex_info["title"], flex_info["body"]),
    )

    # Send message
    result = await line_service.send_flex_message(target_id, flex_message)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to send flex message: {result.error}",
                "source": "line",
            })
        return {"success": False, "error": result.error}

    logger.debug(f"Sent LINE flex message to {target_id}")

    if callback:
        await callback({
            "text": "Card message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "to": target_id,
            "message_id": result.message_id,
        },
    }


send_flex_message_action = {
    "name": "LINE_SEND_FLEX_MESSAGE",
    "similes": ["SEND_LINE_CARD", "LINE_FLEX", "LINE_CARD", "SEND_LINE_FLEX"],
    "description": "Send a rich flex message/card via LINE",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {
                    "text": "Send them an info card with title 'Update' and body 'New features are available'"
                },
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that as a card message.",
                    "actions": ["LINE_SEND_FLEX_MESSAGE"],
                },
            },
        ],
    ],
}
