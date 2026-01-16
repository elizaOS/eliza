from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("WORLD")


async def get_world_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    room_id = message.room_id
    if not room_id:
        return ProviderResult(text="", values={"hasWorld": False}, data={})

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

    sections.append(f"# World: {world.name or 'Unknown'}")
    if world.metadata and world.metadata.get("description"):
        sections.append(f"\n{world.metadata['description']}")

    sections.append(f"\n## Current Room: {room.name or 'Unknown'}")
    if room.metadata and room.metadata.get("topic"):
        sections.append(f"Topic: {room.metadata['topic']}")

    member_count = 0
    if world.metadata and world.metadata.get("members"):
        member_count = len(world.metadata["members"])
    sections.append(f"\n## Members: {member_count}")

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


world_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_world_context,
    dynamic=_spec.get("dynamic", True),
)
