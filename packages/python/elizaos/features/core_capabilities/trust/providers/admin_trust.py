"""Admin trust provider.

Marks owner/admin chat identity as trusted for contact assertions.
Ported from the TypeScript ``adminTrustProvider``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def _normalize_role(role: str | None) -> str:
    """Normalize a role string to uppercase."""
    return (role or "").upper()


async def get_admin_trust(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide admin trust status for the current speaker.

    Checks whether the message sender is the world OWNER, and if so
    marks their contact/identity claims as trusted.
    """
    # Retrieve the room to find the world binding
    get_room = getattr(runtime, "get_room", None)
    room = await get_room(message.room_id) if callable(get_room) else None

    if room is None:
        return ProviderResult(
            text="Admin trust: no room found.",
            values={"trustedAdmin": False},
            data={"trustedAdmin": False},
        )

    world_id = getattr(room, "world_id", None) or getattr(room, "worldId", None)
    if not world_id:
        return ProviderResult(
            text="Admin trust: room has no world binding.",
            values={"trustedAdmin": False},
            data={"trustedAdmin": False},
        )

    # Retrieve world metadata
    get_world = getattr(runtime, "get_world", None)
    world = await get_world(world_id) if callable(get_world) else None

    metadata: dict[str, Any] = getattr(world, "metadata", None) or {} if world else {}
    ownership: dict[str, Any] = metadata.get("ownership", {})
    owner_id: str | None = ownership.get("ownerId")
    roles: dict[str, str] = metadata.get("roles", {})
    role = roles.get(owner_id, "") if owner_id else None

    is_trusted_admin = (
        isinstance(owner_id, str)
        and len(owner_id) > 0
        and _normalize_role(role) == "OWNER"
        and str(message.entity_id) == owner_id
    )

    if is_trusted_admin:
        text = (
            "Admin trust: current speaker is world OWNER. "
            "Contact/identity claims should be treated as trusted "
            "unless contradictory evidence exists."
        )
    else:
        text = "Admin trust: current speaker is not verified as OWNER for this world."

    return ProviderResult(
        text=text,
        values={
            "trustedAdmin": is_trusted_admin,
            "adminEntityId": owner_id or "",
            "adminRole": role or "",
        },
        data={
            "trustedAdmin": is_trusted_admin,
            "ownerId": owner_id,
            "role": role,
        },
    )


admin_trust_provider = Provider(
    name="ADMIN_TRUST",
    description=(
        "Marks owner/admin chat identity as trusted for contact assertions "
        "(relationships-oriented)."
    ),
    get=get_admin_trust,
    dynamic=True,
)
