"""
Send reaction action for the BlueBubbles plugin.
"""

import logging
from typing import Protocol

from ..service import BlueBubblesService
from ..types import BLUEBUBBLES_SERVICE_NAME

logger = logging.getLogger(__name__)


class IAgentRuntime(Protocol):
    """Agent runtime protocol."""

    def get_service(self, service_type: str) -> BlueBubblesService | None:
        """Get a service by type."""
        ...


SEND_REACTION_TEMPLATE = """# Task: Extract BlueBubbles reaction parameters

Based on the conversation, determine what reaction to add or remove.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji reaction to add (heart, thumbsup, thumbsdown, haha, \
exclamation, question, or any emoji)
2. messageId: The message ID to react to (or "last" for the last message)
3. remove: true to remove the reaction, false to add it

Respond with a JSON object:
```json
{
  "emoji": "❤️",
  "messageId": "last",
  "remove": false
}
```
"""


async def send_reaction_handler(
    runtime: IAgentRuntime,
    message: dict,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
) -> dict:
    """Handle send reaction action."""
    bb_service = runtime.get_service(BLUEBUBBLES_SERVICE_NAME)

    if not bb_service or not bb_service.is_connected():
        if callback:
            callback({"text": "BlueBubbles service is not available.", "source": "bluebubbles"})
        return {"success": False, "error": "BlueBubbles service not available"}

    # Get chat context
    state_data = (state or {}).get("data", {})
    chat_guid = state_data.get("chatGuid")
    message_guid = state_data.get("lastMessageGuid")

    if not chat_guid:
        if callback:
            callback({
                "text": "I couldn't determine the chat to react in.",
                "source": "bluebubbles"
            })
        return {"success": False, "error": "Could not determine chat"}

    if not message_guid:
        if callback:
            callback({"text": "I couldn't find the message to react to.", "source": "bluebubbles"})
        return {"success": False, "error": "Could not find message to react to"}

    # Default emoji (would be extracted by LLM in real usage)
    emoji = "❤️"
    remove = False

    # Send reaction
    result = await bb_service.send_reaction(chat_guid, message_guid, emoji, remove)

    if not result.success:
        action_text = "remove" if remove else "add"
        if callback:
            callback({
                "text": f"Failed to {action_text} reaction: {result.error}",
                "source": "bluebubbles",
            })
        return {"success": False, "error": result.error}

    logger.debug(f"{'Removed' if remove else 'Added'} reaction {emoji} on {message_guid}")

    content = message.get("content", {})
    if callback:
        callback({
            "text": "Reaction removed." if remove else f"Reacted with {emoji}.",
            "source": content.get("source", "bluebubbles"),
        })

    return {
        "success": True,
        "data": {
            "emoji": emoji,
            "messageGuid": message_guid,
            "removed": remove,
        },
    }


def _validate_reaction(runtime, message, state=None):
    return message.get("content", {}).get("source") == "bluebubbles"


send_reaction_action = {
    "name": "BLUEBUBBLES_SEND_REACTION",
    "similes": ["BLUEBUBBLES_REACT", "BB_REACTION", "IMESSAGE_REACT"],
    "description": "Add or remove a reaction on a message via BlueBubbles",
    "validate": _validate_reaction,
    "handler": send_reaction_handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "React to that message with a heart"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll add a heart reaction.",
                    "actions": ["BLUEBUBBLES_SEND_REACTION"],
                },
            },
        ],
    ],
}
