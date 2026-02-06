"""
Send message action for Google Chat plugin.
"""

import json
import logging
import re

from ..types import (
    GOOGLE_CHAT_SERVICE_NAME,
    GoogleChatMessageSendOptions,
    normalize_space_target,
    split_message_for_google_chat,
)

logger = logging.getLogger(__name__)

SEND_MESSAGE_TEMPLATE = """# Task: Extract Google Chat send message parameters
Based on the conversation, determine what message to send and to which space.

Recent conversation:
{recent_messages}

Extract the following:
- text: The message content to send
- space: The target space ID (or "current" for the current space)
- thread: Optional thread name to reply in

Respond with a JSON object:
```json
{{
  "text": "message content here",
  "space": "spaces/xxx or current",
  "thread": "optional thread name"
}}
```"""


async def validate(runtime, message, state: dict | None = None) -> bool:
    """Validate that this action can be executed."""
    return message.content.get("source") == "google-chat"


async def handler(
    runtime,
    message,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
):
    """Handle the send message action."""
    gchat_service = runtime.get_service(GOOGLE_CHAT_SERVICE_NAME)

    if not gchat_service or not gchat_service.is_connected():
        if callback:
            await callback({"text": "Google Chat service is not available.", "source": "google-chat"})
        return {"success": False, "error": "Google Chat service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_MESSAGE_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    message_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    message_info = {
                        "text": str(parsed["text"]),
                        "space": str(parsed.get("space", "current")),
                        "thread": str(parsed.get("thread")) if parsed.get("thread") else None,
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not message_info or not message_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send.",
                "source": "google-chat",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target space
    target_space = None
    if message_info["space"] and message_info["space"] != "current":
        normalized = normalize_space_target(message_info["space"])
        if normalized:
            target_space = normalized

    # Get space from state if available
    if not target_space:
        state_data = state.get("data", {}) if state else {}
        space = state_data.get("space", {})
        target_space = space.get("name")

    if not target_space:
        if callback:
            await callback({
                "text": "I couldn't determine which space to send to.",
                "source": "google-chat",
            })
        return {"success": False, "error": "Could not determine target space"}

    # Split message if too long
    chunks = split_message_for_google_chat(message_info["text"])

    # Send message(s)
    last_result = None
    for chunk in chunks:
        opts = GoogleChatMessageSendOptions(
            space=target_space,
            text=chunk,
            thread=message_info.get("thread"),
        )
        result = await gchat_service.send_message(opts)

        if not result.success:
            if callback:
                await callback({
                    "text": f"Failed to send message: {result.error}",
                    "source": "google-chat",
                })
            return {"success": False, "error": result.error}

        last_result = {"message_name": result.message_name}
        logger.debug(f"Sent Google Chat message: {result.message_name}")

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "space": target_space,
            "message_name": last_result.get("message_name") if last_result else None,
            "chunks_count": len(chunks),
        },
    }


send_message_action = {
    "name": "GOOGLE_CHAT_SEND_MESSAGE",
    "similes": [
        "SEND_GOOGLE_CHAT_MESSAGE",
        "MESSAGE_GOOGLE_CHAT",
        "GCHAT_SEND",
        "GOOGLE_CHAT_TEXT",
    ],
    "description": "Send a message to a Google Chat space",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send a message saying 'Hello everyone!'"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that message to the space.",
                    "actions": ["GOOGLE_CHAT_SEND_MESSAGE"],
                },
            },
        ],
    ],
}
