"""
Send reaction action for Signal plugin.
"""

import json
import re
from typing import Optional

from elizaos_plugin_signal.types import SIGNAL_SERVICE_NAME


SEND_REACTION_TEMPLATE = """You are helping to extract reaction parameters for Signal.

The user wants to react to a Signal message with an emoji.

Recent conversation:
{recent_messages}

Extract the following:
1. emoji: The emoji to react with (single emoji character)
2. targetTimestamp: The timestamp of the message to react to (number)
3. targetAuthor: The phone number of the message author
4. remove: Whether to remove the reaction instead of adding it (default: false)

Respond with a JSON object like:
{{
  "emoji": "👍",
  "targetTimestamp": 1234567890000,
  "targetAuthor": "+1234567890",
  "remove": false
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
    """Handle the send reaction action."""
    signal_service = runtime.get_service(SIGNAL_SERVICE_NAME)

    if not signal_service or not signal_service.is_service_connected():
        if callback:
            await callback({"text": "Signal service is not available.", "source": "signal"})
        return {"success": False, "error": "Signal service not available"}

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
                if (
                    parsed.get("emoji")
                    and parsed.get("targetTimestamp")
                    and parsed.get("targetAuthor")
                ):
                    reaction_info = {
                        "emoji": str(parsed["emoji"]),
                        "target_timestamp": int(parsed["targetTimestamp"]),
                        "target_author": str(parsed["targetAuthor"]),
                        "remove": bool(parsed.get("remove", False)),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not reaction_info:
        if callback:
            await callback({
                "text": "I couldn't understand the reaction request. Please specify the emoji and message to react to.",
                "source": "signal",
            })
        return {"success": False, "error": "Could not extract reaction parameters"}

    # Get room info
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room") or await runtime.get_room(message.room_id)
    recipient = room.get("channel_id", "") if room else reaction_info["target_author"]

    # Send or remove reaction
    if reaction_info["remove"]:
        await signal_service.remove_reaction(
            recipient,
            reaction_info["emoji"],
            reaction_info["target_timestamp"],
            reaction_info["target_author"],
        )
    else:
        await signal_service.send_reaction(
            recipient,
            reaction_info["emoji"],
            reaction_info["target_timestamp"],
            reaction_info["target_author"],
        )

    action_word = "removed" if reaction_info["remove"] else "added"

    if callback:
        await callback({
            "text": f"Reaction {reaction_info['emoji']} {action_word} successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "emoji": reaction_info["emoji"],
            "target_timestamp": reaction_info["target_timestamp"],
            "target_author": reaction_info["target_author"],
            "action": action_word,
        },
    }


send_reaction_action = {
    "name": "SIGNAL_SEND_REACTION",
    "similes": [
        "REACT_SIGNAL",
        "SIGNAL_REACT",
        "ADD_SIGNAL_REACTION",
        "SIGNAL_EMOJI",
    ],
    "description": "React to a Signal message with an emoji",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "React to the last message with a thumbs up"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll add a thumbs up reaction.",
                    "actions": ["SIGNAL_SEND_REACTION"],
                },
            },
        ]
    ],
}
