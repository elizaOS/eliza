"""
Roles Provider - Provides role information for entities.

This provider returns information about roles assigned to
entities within the current world context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def format_role_info(entity_name: str, role: str) -> str:
    """Format role information for display."""
    return f"- {entity_name}: {role}"


async def get_roles(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get role information for the current context.

    Returns information about roles assigned to entities
    in the current world/room context.
    """
    role_info: list[dict[str, str]] = []

    # Get world context if available
    world_id = None
    if state and hasattr(state, "world"):
        world = state.world
        if world and hasattr(world, "id"):
            world_id = world.id

    if not world_id and message.room_id:
        try:
            room = await runtime.get_room(message.room_id)
            if room and hasattr(room, "world_id"):
                world_id = room.world_id
        except Exception:
            pass

    if world_id:
        try:
            world = await runtime.get_world(world_id)
            if world and hasattr(world, "metadata"):
                roles = world.metadata.get("roles", {})
                if isinstance(roles, dict):
                    for entity_id, role in roles.items():
                        try:
                            entity = await runtime.get_entity(entity_id)
                            entity_name = entity.name if entity else str(entity_id)[:8]
                        except Exception:
                            entity_name = str(entity_id)[:8]

                        role_info.append({
                            "entityId": str(entity_id),
                            "entityName": entity_name,
                            "role": str(role),
                        })
        except Exception as e:
            runtime.logger.debug(
                {
                    "src": "provider:roles",
                    "agentId": runtime.agent_id,
                    "error": str(e),
                },
                "Failed to get world roles",
            )

    # Also include the sender's role if known
    if message.entity_id:
        try:
            entity = await runtime.get_entity(message.entity_id)
            if entity and hasattr(entity, "metadata"):
                sender_role = entity.metadata.get("role")
                if sender_role:
                    # Check if already in list
                    existing = next(
                        (r for r in role_info if r["entityId"] == str(message.entity_id)),
                        None,
                    )
                    if not existing:
                        role_info.append({
                            "entityId": str(message.entity_id),
                            "entityName": entity.name or "Unknown",
                            "role": str(sender_role),
                        })
        except Exception:
            pass

    if not role_info:
        return ProviderResult(
            text="",
            values={
                "roleCount": 0,
            },
            data={
                "roles": [],
            },
        )

    formatted_roles = "\n".join(
        format_role_info(r["entityName"], r["role"]) for r in role_info
    )

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


# Create the provider instance
roles_provider = Provider(
    name="ROLES",
    description="Roles assigned to entities in the current context",
    get=get_roles,
    dynamic=True,
)


