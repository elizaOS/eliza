from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def format_role_info(entity_name: str, role: str) -> str:
    return f"- {entity_name}: {role}"


async def get_roles(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    role_info: list[dict[str, str]] = []

    world_id = None
    if state and hasattr(state, "world"):
        world = state.world
        if world and hasattr(world, "id"):
            world_id = world.id

    if not world_id and message.room_id:
        room = await runtime.get_room(message.room_id)
        if room and hasattr(room, "world_id"):
            world_id = room.world_id

    if world_id:
        world = await runtime.get_world(world_id)
        if world and hasattr(world, "metadata"):
            roles = world.metadata.get("roles", {})
            if isinstance(roles, dict):
                entity_ids = list(roles.keys())
                entities = await asyncio.gather(
                    *(runtime.get_entity(entity_id) for entity_id in entity_ids)
                )
                for entity_id, entity, role in zip(
                    entity_ids, entities, roles.values(), strict=False
                ):
                    entity_name = entity.name if entity else str(entity_id)[:8]

                    role_info.append(
                        {
                            "entityId": str(entity_id),
                            "entityName": entity_name,
                            "role": str(role),
                        }
                    )

    if message.entity_id:
        entity = await runtime.get_entity(message.entity_id)
        if entity and hasattr(entity, "metadata"):
            sender_role = entity.metadata.get("role")
            if sender_role:
                existing = next(
                    (r for r in role_info if r["entityId"] == str(message.entity_id)), None
                )
                if not existing:
                    role_info.append(
                        {
                            "entityId": str(message.entity_id),
                            "entityName": entity.name or "Unknown",
                            "role": str(sender_role),
                        }
                    )

    if not role_info:
        return ProviderResult(text="", values={"roleCount": 0}, data={"roles": []})

    formatted_roles = "\n".join(format_role_info(r["entityName"], r["role"]) for r in role_info)

    text = f"# Entity Roles\n{formatted_roles}"

    return ProviderResult(
        text=text,
        values={
            "roleCount": len(role_info),
            "roles": {r["entityName"]: r["role"] for r in role_info},
        },
        data={
            "roles": role_info,
        },
    )


roles_provider = Provider(
    name="ROLES",
    description="Roles assigned to entities in the current context",
    get=get_roles,
    dynamic=True,
)
