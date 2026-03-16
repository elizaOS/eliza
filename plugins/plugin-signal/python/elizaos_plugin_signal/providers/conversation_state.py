"""
Conversation state provider for Signal plugin.
"""

from typing import Optional

from elizaos_plugin_signal.types import (
    get_signal_contact_display_name,
    SIGNAL_SERVICE_NAME,
)


async def get_conversation_state(
    runtime,
    message,
    state: Optional[dict] = None,
):
    """Get the current Signal conversation state."""
    state_data = state.get("data", {}) if state else {}
    room = state_data.get("room") or await runtime.get_room(message.room_id)

    if not room:
        return {
            "data": {},
            "values": {},
            "text": "",
        }

    # If message source is not signal, return empty
    if message.content.get("source") != "signal":
        return {
            "data": {},
            "values": {},
            "text": "",
        }

    agent_name = state.get("agentName", "The agent") if state else "The agent"
    sender_name = state.get("senderName", "someone") if state else "someone"

    response_text = ""
    conversation_type = ""
    contact_name = ""
    group_name = ""
    channel_id = room.get("channel_id", "")

    signal_service = runtime.get_service(SIGNAL_SERVICE_NAME)
    if not signal_service or not signal_service.is_service_connected():
        return {
            "data": {
                "room": room,
                "conversation_type": "unknown",
                "channel_id": channel_id,
            },
            "values": {
                "conversation_type": "unknown",
                "channel_id": channel_id,
            },
            "text": "",
        }

    is_group = room.get("metadata", {}).get("is_group", False)

    if is_group:
        conversation_type = "GROUP"
        group_id = room.get("metadata", {}).get("group_id", "")
        group = signal_service.get_cached_group(group_id)
        group_name = group.name if group else room.get("name", "Unknown Group")

        response_text = f'{agent_name} is currently in a Signal group chat: "{group_name}".'
        response_text += f"\n{agent_name} should be aware that multiple people can see this conversation and should participate when relevant."

        if group and group.description:
            response_text += f"\nGroup description: {group.description}"
    else:
        conversation_type = "DM"
        contact = signal_service.get_contact(channel_id)
        contact_name = (
            get_signal_contact_display_name(contact) if contact else sender_name
        )

        response_text = f"{agent_name} is currently in a direct message conversation with {contact_name} on Signal."
        response_text += f"\n{agent_name} should engage naturally in conversation, responding to messages addressed to them."

    response_text += "\n\nSignal is an encrypted messaging platform, so all messages are secure and private."

    return {
        "data": {
            "room": room,
            "conversation_type": conversation_type,
            "contact_name": contact_name,
            "group_name": group_name,
            "channel_id": channel_id,
            "is_group": is_group,
            "account_number": signal_service.get_account_number(),
        },
        "values": {
            "conversation_type": conversation_type,
            "contact_name": contact_name,
            "group_name": group_name,
            "channel_id": channel_id,
            "is_group": is_group,
        },
        "text": response_text,
    }


conversation_state_provider = {
    "name": "signalConversationState",
    "description": "Provides information about the current Signal conversation context",
    "get": get_conversation_state,
}
