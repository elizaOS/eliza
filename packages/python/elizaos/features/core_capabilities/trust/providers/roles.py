"""Roles provider.

Provides the server role hierarchy (Owner, Admin, Member) for the
current room/world context. Ported from the TypeScript ``roleProvider``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_roles(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide the server role hierarchy for the current room."""
    # Retrieve room
    get_room = getattr(runtime, "get_room", None)
    room = await get_room(message.room_id) if callable(get_room) else None

    if room is None:
        return ProviderResult(
            text="No room context available for role information.",
            values={"roles": "No room context available for role information."},
            data={"roles": []},
        )

    # Only available in group contexts
    room_type = getattr(room, "type", None) or getattr(room, "channel_type", None)
    if room_type and str(room_type).upper() not in ("GROUP", "WORLD"):
        return ProviderResult(
            text="No access to role information in DMs, the role provider is only available in group scenarios.",
            values={
                "roles": "No access to role information in DMs, the role provider is only available in group scenarios.",
            },
            data={"roles": []},
        )

    server_id = getattr(room, "message_server_id", None) or getattr(room, "messageServerId", None)
    if not server_id:
        return ProviderResult(
            text="No role information available for this server.",
            values={"roles": "No role information available for this server."},
            data={"roles": []},
        )

    # Retrieve world
    world_id = getattr(room, "world_id", None) or getattr(room, "worldId", None)
    if not world_id:
        # Try to construct from server_id
        create_uuid = getattr(runtime, "create_unique_uuid", None)
        world_id = create_uuid(server_id) if callable(create_uuid) else server_id

    get_world = getattr(runtime, "get_world", None)
    world = await get_world(world_id) if callable(get_world) else None

    if world is None:
        return ProviderResult(
            text="No role information available for this server.",
            values={"roles": "No role information available for this server."},
            data={"roles": []},
        )

    metadata: dict[str, Any] = getattr(world, "metadata", None) or {}
    ownership = metadata.get("ownership", {})
    if not ownership.get("ownerId"):
        return ProviderResult(
            text="No role information available for this server.",
            values={"roles": "No role information available for this server."},
            data={"roles": []},
        )

    roles: dict[str, str] = metadata.get("roles", {})
    if not roles:
        return ProviderResult(
            text="No role information available for this server.",
            values={"roles": "No role information available for this server."},
            data={"roles": []},
        )

    # Categorize entities by role
    owners: list[dict[str, str]] = []
    admins: list[dict[str, str]] = []
    members: list[dict[str, str]] = []

    get_entity = getattr(runtime, "get_entity_by_id", None)

    for entity_id, user_role in roles.items():
        # Try to resolve entity name
        name = entity_id
        if callable(get_entity):
            try:
                entity = await get_entity(entity_id)
                if entity:
                    names = getattr(entity, "names", None) or []
                    entity_meta = getattr(entity, "metadata", None) or {}
                    default_meta = (
                        entity_meta.get("default", {}) if isinstance(entity_meta, dict) else {}
                    )
                    name = default_meta.get("name") or (names[0] if names else None) or entity_id
            except Exception:
                pass

        entry = {"name": str(name), "entityId": entity_id, "role": user_role}
        role_upper = user_role.upper() if user_role else ""
        if role_upper == "OWNER":
            owners.append(entry)
        elif role_upper == "ADMIN":
            admins.append(entry)
        else:
            members.append(entry)

    # Build response text
    parts: list[str] = ["# Server Role Hierarchy\n"]

    if owners:
        parts.append("## Owners")
        for o in owners:
            parts.append(f"{o['name']} ({o['entityId']})")
        parts.append("")

    if admins:
        parts.append("## Administrators")
        for a in admins:
            parts.append(f"{a['name']} ({a['entityId']})")
        parts.append("")

    if members:
        parts.append("## Members")
        for m in members:
            parts.append(f"{m['name']} ({m['entityId']})")

    if not owners and not admins and not members:
        return ProviderResult(
            text="No role information available for this server.",
            values={"roles": "No role information available for this server."},
            data={"roles": []},
        )

    response_text = "\n".join(parts)

    return ProviderResult(
        text=response_text,
        values={"roles": response_text},
        data={"roles": response_text},
    )


role_provider = Provider(
    name="ROLES",
    description="Roles in the server, default are OWNER, ADMIN and MEMBER (as well as NONE)",
    get=get_roles,
    dynamic=True,
)
