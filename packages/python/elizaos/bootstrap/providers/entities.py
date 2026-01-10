"""
Entities Provider - Provides information about entities in the current context.

This provider supplies information about users, agents, and other entities
that are relevant to the current conversation or room.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_entities_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the entities context for the current room/conversation.

    Returns entity information including:
    - Current user/sender
    - Other participants
    - Entity roles and relationships
    """
    room_id = message.room_id
    sender_id = message.entity_id

    sections: list[str] = []
    entity_list: list[dict[str, str]] = []

    # Get sender entity
    if sender_id:
        sender = await runtime.get_entity(sender_id)
        if sender:
            sender_info = {
                "id": str(sender.id),
                "name": sender.name or "Unknown",
                "type": sender.entity_type or "user",
                "role": "sender",
            }
            entity_list.append(sender_info)
            sections.append(
                f"- **{sender.name or 'Unknown'}** (sender): {sender.entity_type or 'user'}"
            )

    # Get room participants if available
    if room_id:
        room = await runtime.get_room(room_id)
        if room and room.world_id:
            world = await runtime.get_world(room.world_id)
            if world and world.metadata:
                # Get entities from world
                member_ids = world.metadata.get("members", [])
                roles = world.metadata.get("roles", {})

                for member_id in member_ids:
                    if str(member_id) == str(sender_id):
                        continue  # Skip sender, already added

                    entity = await runtime.get_entity(member_id)
                    if entity:
                        role = roles.get(str(member_id), "member")
                        entity_info = {
                            "id": str(entity.id),
                            "name": entity.name or "Unknown",
                            "type": entity.entity_type or "user",
                            "role": role,
                        }
                        entity_list.append(entity_info)
                        sections.append(
                            f"- **{entity.name or 'Unknown'}** ({role}): {entity.entity_type or 'user'}"
                        )

    # Add agent itself
    agent_entity = await runtime.get_entity(runtime.agent_id)
    if agent_entity:
        agent_info = {
            "id": str(agent_entity.id),
            "name": agent_entity.name or runtime.character.name,
            "type": "agent",
            "role": "self",
        }
        entity_list.append(agent_info)
        sections.append(f"- **{agent_entity.name or runtime.character.name}** (self): agent")

    context_text = "# Entities in Context\n" + "\n".join(sections) if sections else ""

    return ProviderResult(
        text=context_text,
        values={
            "entityCount": len(entity_list),
            "hasSender": sender_id is not None,
            "agentId": str(runtime.agent_id),
        },
        data={
            "entities": entity_list,
            "senderId": str(sender_id) if sender_id else None,
            "agentId": str(runtime.agent_id),
        },
    )


# Create the provider instance
entities_provider = Provider(
    name="ENTITIES",
    description="Provides information about entities in the current context (users, agents, participants)",
    get=get_entities_context,
    dynamic=True,  # Entities may change between messages
)
