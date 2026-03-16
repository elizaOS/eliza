"""Chat state provider for BlueBubbles."""

import logging
from datetime import datetime
from typing import Any

from elizaos.types import Memory, Provider, State

from elizaos_plugin_bluebubbles.types import BlueBubblesChatState

logger = logging.getLogger(__name__)

BLUEBUBBLES_SERVICE_NAME = "bluebubbles"


async def get_chat_state(
    runtime: Any,
    message: Memory,
    state: State | None = None,
) -> str:
    """Gets the chat state for BlueBubbles."""
    service = runtime.get_service(BLUEBUBBLES_SERVICE_NAME)

    if not service or not service.is_running:
        return ""

    try:
        room = await runtime.get_room(message.room_id)
        if not room or not room.channel_id:
            return ""

        # Only provide state for BlueBubbles channels
        if room.source != "bluebubbles":
            return ""

        chat_state = await service.get_chat_state(room.channel_id)
        if not chat_state:
            return ""

        return _format_chat_state(chat_state)

    except Exception as e:
        logger.debug("Failed to get BlueBubbles chat state: %s", e)
        return ""


def _format_chat_state(state: BlueBubblesChatState) -> str:
    """Formats the chat state for inclusion in prompts."""
    lines = [
        "# iMessage Chat Context (BlueBubbles)",
        "",
        f"- Chat Type: {'Group Chat' if state.is_group else 'Direct Message'}",
    ]

    if state.display_name:
        lines.append(f"- Chat Name: {state.display_name}")

    if state.is_group:
        lines.append(f"- Participants: {', '.join(state.participants)}")
    else:
        contact = state.participants[0] if state.participants else state.chat_identifier
        lines.append(f"- Contact: {contact}")

    if state.last_message_at:
        dt = datetime.fromtimestamp(state.last_message_at / 1000)
        lines.append(f"- Last Message: {dt.strftime('%Y-%m-%d %H:%M:%S')}")

    if state.has_unread:
        lines.append("- Has Unread Messages: Yes")

    lines.append("")
    lines.append(
        "Note: This conversation is happening through iMessage. "
        "Be conversational and friendly."
    )

    return "\n".join(lines)


chat_state_provider = Provider(
    name="BLUEBUBBLES_CHAT_STATE",
    description="Provides information about the current BlueBubbles/iMessage chat context",
    get=get_chat_state,
)
