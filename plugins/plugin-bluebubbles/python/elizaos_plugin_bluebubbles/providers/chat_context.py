"""
Chat context provider for the BlueBubbles plugin.
"""

from typing import Protocol

from ..service import BlueBubblesService
from ..types import BLUEBUBBLES_SERVICE_NAME, extract_handle_from_chat_guid


class IAgentRuntime(Protocol):
    """Agent runtime protocol."""

    def get_service(self, service_type: str) -> BlueBubblesService | None:
        """Get a service by type."""
        ...


async def chat_context_get(
    runtime: IAgentRuntime,
    message: dict,
    state: dict | None = None,
) -> dict:
    """Get chat context."""
    # Only provide context for BlueBubbles messages
    content = message.get("content", {})
    if content.get("source") != "bluebubbles":
        return {
            "data": {},
            "values": {},
            "text": "",
        }

    bb_service = runtime.get_service(BLUEBUBBLES_SERVICE_NAME)

    if not bb_service or not bb_service.is_connected():
        return {
            "data": {"connected": False},
            "values": {"connected": False},
            "text": "",
        }

    state = state or {}
    agent_name = state.get("agentName", "The agent")
    state_data = state.get("data", {})

    chat_guid = state_data.get("chatGuid")
    handle = state_data.get("handle")
    display_name = state_data.get("displayName")

    # Determine chat type from GUID
    chat_type = "direct"
    chat_description = ""

    if chat_guid:
        if ";+;" in chat_guid:
            chat_type = "group"
            chat_description = f'group chat "{display_name}"' if display_name else "a group chat"
        else:
            extracted_handle = extract_handle_from_chat_guid(chat_guid)
            if extracted_handle:
                chat_description = f"direct message with {extracted_handle}"
            elif handle:
                chat_description = f"direct message with {handle}"
            else:
                chat_description = "a direct message"
    elif handle:
        chat_description = f"direct message with {handle}"
    else:
        chat_description = "an iMessage conversation"

    response_text = (
        f"{agent_name} is chatting via iMessage (BlueBubbles) in {chat_description}. "
        "This channel supports reactions, effects (slam, balloons, confetti, etc.), "
        "editing, and replying to messages."
    )

    return {
        "data": {
            "chatGuid": chat_guid,
            "handle": handle,
            "displayName": display_name,
            "chatType": chat_type,
            "connected": True,
            "platform": "bluebubbles",
            "supportsReactions": True,
            "supportsEffects": True,
            "supportsEdit": True,
            "supportsReply": True,
        },
        "values": {
            "chatGuid": chat_guid,
            "handle": handle,
            "displayName": display_name,
            "chatType": chat_type,
        },
        "text": response_text,
    }


chat_context_provider = {
    "name": "bluebubblesChatContext",
    "description": "Provides information about the current BlueBubbles/iMessage chat context",
    "get": chat_context_get,
}
