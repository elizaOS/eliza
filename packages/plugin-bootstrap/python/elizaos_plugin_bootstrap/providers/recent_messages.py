"""
Recent Messages Provider - Provides recent message history.

This provider supplies the recent conversation history
to give the agent context about the ongoing discussion.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_recent_messages_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get recent messages from the current room.

    Returns:
    - Recent message history
    - Formatted conversation context
    - Message metadata
    """
    room_id = message.room_id
    if not room_id:
        return ProviderResult(
            text="",
            values={"messageCount": 0, "hasHistory": False},
            data={"messages": []},
        )

    sections: list[str] = []
    message_list: list[dict[str, str | int]] = []

    try:
        # Get recent messages from the room
        recent_messages = await runtime.get_memories(
            room_id=room_id,
            limit=20,
            order_by="created_at",
            order_direction="desc",
        )

        # Reverse to get chronological order
        recent_messages = list(reversed(recent_messages))

        for msg in recent_messages:
            # Skip if no content
            if not msg.content or not msg.content.text:
                continue

            # Get sender name
            sender_name = "Unknown"
            if msg.entity_id:
                entity = await runtime.get_entity(msg.entity_id)
                if entity and entity.name:
                    sender_name = entity.name
                elif str(msg.entity_id) == str(runtime.agent_id):
                    sender_name = runtime.character.name

            message_text = msg.content.text
            # Truncate very long messages
            if len(message_text) > 300:
                message_text = message_text[:300] + "..."

            msg_dict = {
                "id": str(msg.id) if msg.id else "",
                "sender": sender_name,
                "text": message_text,
                "timestamp": msg.created_at or 0,
            }
            message_list.append(msg_dict)
            sections.append(f"**{sender_name}**: {message_text}")

    except Exception as e:
        runtime.logger.warning(
            {"src": "provider:recentMessages", "error": str(e)},
            "Error fetching recent messages",
        )

    context_text = ""
    if sections:
        context_text = "# Recent Messages\n" + "\n".join(sections)

    return ProviderResult(
        text=context_text,
        values={
            "messageCount": len(message_list),
            "hasHistory": len(message_list) > 0,
            "roomId": str(room_id),
        },
        data={
            "messages": message_list,
            "roomId": str(room_id),
        },
    )


# Create the provider instance
recent_messages_provider = Provider(
    name="RECENT_MESSAGES",
    description="Provides recent message history from the current conversation",
    get=get_recent_messages_context,
    dynamic=True,  # Messages change constantly
)

