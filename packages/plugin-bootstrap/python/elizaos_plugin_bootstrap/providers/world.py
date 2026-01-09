"""
World Provider - Provides information about the current world context.

This provider supplies world-level information including settings,
members, rooms, and world metadata.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_world_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the world context for the current conversation.

    Returns world information including:
    - World name and description
    - Member list
    - Room information
    - World settings
    """
    room_id = message.room_id
    if not room_id:
        return ProviderResult(
            text="",
            values={"hasWorld": False},
            data={},
        )

    room = await runtime.get_room(room_id)
    if not room or not room.world_id:
        return ProviderResult(
            text="",
            values={"hasWorld": False, "roomId": str(room_id)},
            data={"roomId": str(room_id)},
        )

    world = await runtime.get_world(room.world_id)
    if not world:
        return ProviderResult(
            text="",
            values={"hasWorld": False, "roomId": str(room_id)},
            data={"roomId": str(room_id)},
        )

    sections: list[str] = []

    # World name and description
    sections.append(f"# World: {world.name or 'Unknown'}")
    if world.metadata and world.metadata.get("description"):
        sections.append(f"\n{world.metadata['description']}")

    # Room info
    sections.append(f"\n## Current Room: {room.name or 'Unknown'}")
    if room.metadata and room.metadata.get("topic"):
        sections.append(f"Topic: {room.metadata['topic']}")

    # Member count
    member_count = 0
    if world.metadata and world.metadata.get("members"):
        member_count = len(world.metadata["members"])
    sections.append(f"\n## Members: {member_count}")

    # Settings (filtered for safety)
    if world.metadata and world.metadata.get("settings"):
        safe_settings = {
            k: v
            for k, v in world.metadata["settings"].items()
            if not k.lower().endswith(("key", "secret", "password", "token"))
        }
        if safe_settings:
            settings_list = [f"- {k}: {v}" for k, v in safe_settings.items()]
            sections.append("\n## Settings\n" + "\n".join(settings_list))

    context_text = "\n".join(sections)

    return ProviderResult(
        text=context_text,
        values={
            "hasWorld": True,
            "worldId": str(world.id),
            "worldName": world.name or "Unknown",
            "roomId": str(room_id),
            "roomName": room.name or "Unknown",
            "memberCount": member_count,
        },
        data={
            "world": {
                "id": str(world.id),
                "name": world.name,
                "metadata": world.metadata,
            },
            "room": {
                "id": str(room_id),
                "name": room.name,
                "metadata": room.metadata,
            },
        },
    )


# Create the provider instance
world_provider = Provider(
    name="WORLD",
    description="Provides information about the current world context including settings and members",
    get=get_world_context,
    dynamic=True,  # World state may change
)

