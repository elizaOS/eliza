"""
Send reaction action for Google Chat plugin.
"""

import json
import logging
import re

from ..types import GOOGLE_CHAT_SERVICE_NAME

logger = logging.getLogger(__name__)

SEND_REACTION_TEMPLATE = """# Task: Extract Google Chat reaction parameters
Based on the conversation, determine the emoji reaction to add or remove.

Recent conversation:
{recent_messages}

Extract the following:
- emoji: The emoji to react with (Unicode emoji character)
- messageName: The message resource name to react to
- remove: Whether to remove the reaction (true/false)

Respond with a JSON object:
```json
{{
  "emoji": "👍",
  "messageName": "spaces/xxx/messages/yyy",
  "remove": false
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
    """Handle the send reaction action."""
    gchat_service = runtime.get_service(GOOGLE_CHAT_SERVICE_NAME)

    if not gchat_service or not gchat_service.is_connected():
        if callback:
            await callback({"text": "Google Chat service is not available.", "source": "google-chat"})
        return {"success": False, "error": "Google Chat service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_REACTION_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    reaction_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("emoji") and parsed.get("messageName"):
                    reaction_info = {
                        "emoji": str(parsed["emoji"]),
                        "message_name": str(parsed["messageName"]),
                        "remove": parsed.get("remove") is True,
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not reaction_info:
        if callback:
            await callback({
                "text": "I couldn't understand the reaction details.",
                "source": "google-chat",
            })
        return {"success": False, "error": "Could not extract reaction parameters"}

    # Get message name from state if not provided
    target_message = reaction_info["message_name"]
    if not target_message:
        state_data = state.get("data", {}) if state else {}
        msg = state_data.get("message", {})
        target_message = msg.get("name")

    if not target_message:
        if callback:
            await callback({
                "text": "I couldn't determine which message to react to.",
                "source": "google-chat",
            })
        return {"success": False, "error": "Could not determine target message"}

    # Handle remove case
    if reaction_info["remove"]:
        reactions = await gchat_service.list_reactions(target_message)
        bot_user = gchat_service.get_bot_user()

        to_remove = []
        for r in reactions:
            user_name = r.user.name if r.user else None
            if bot_user and user_name != bot_user and user_name != "users/app":
                continue
            if reaction_info["emoji"] and r.emoji != reaction_info["emoji"]:
                continue
            to_remove.append(r)

        for reaction in to_remove:
            if reaction.name:
                await gchat_service.delete_reaction(reaction.name)

        if callback:
            await callback({
                "text": f"Removed {len(to_remove)} reaction(s).",
                "source": message.content.get("source"),
            })

        return {"success": True, "data": {"removed": len(to_remove)}}

    # Add reaction
    result = await gchat_service.send_reaction(target_message, reaction_info["emoji"])

    if not result.get("success"):
        if callback:
            await callback({
                "text": f"Failed to add reaction: {result.get('error')}",
                "source": "google-chat",
            })
        return {"success": False, "error": result.get("error")}

    if callback:
        await callback({
            "text": f"Added {reaction_info['emoji']} reaction.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "reaction_name": result.get("name"),
            "emoji": reaction_info["emoji"],
        },
    }


send_reaction_action = {
    "name": "GOOGLE_CHAT_SEND_REACTION",
    "similes": [
        "REACT_GOOGLE_CHAT",
        "GCHAT_REACT",
        "GOOGLE_CHAT_EMOJI",
        "ADD_GOOGLE_CHAT_REACTION",
    ],
    "description": "Add or remove an emoji reaction to a Google Chat message",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "React with a thumbs up to that message"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll add a thumbs up reaction.",
                    "actions": ["GOOGLE_CHAT_SEND_REACTION"],
                },
            },
        ],
    ],
}
