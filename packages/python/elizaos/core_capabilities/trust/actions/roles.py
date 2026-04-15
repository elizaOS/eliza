"""Update role action.

Allows an authorized entity (OWNER or ADMIN) to assign roles to other
entities in a world/server context.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


class Role(StrEnum):
    """Standard role hierarchy."""

    OWNER = "OWNER"
    ADMIN = "ADMIN"
    NONE = "NONE"


def _can_modify_role(current_role: Role, target_role: Role | None, new_role: Role) -> bool:
    """Check if *current_role* is allowed to change *target_role* to *new_role*."""
    if target_role == current_role:
        return False
    if current_role == Role.OWNER:
        return True
    if current_role == Role.ADMIN:
        return new_role != Role.OWNER
    return False


def _parse_role(value: str) -> Role | None:
    """Parse a string into a Role enum, returning None if invalid."""
    try:
        return Role(value.upper())
    except (ValueError, AttributeError):
        return None


@dataclass
class UpdateRoleAction:
    """Assign a role (Admin, Owner, None) to a user in a channel/world."""

    name: str = "UPDATE_ROLE"
    similes: list[str] = field(
        default_factory=lambda: [
            "CHANGE_ROLE",
            "SET_PERMISSIONS",
            "ASSIGN_ROLE",
            "MAKE_ADMIN",
        ]
    )
    description: str = (
        "Assigns a role (Admin, Owner, None) to a user or list of users in a channel."
    )

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | None = None,
    ) -> bool:
        """Validate that the message is in a group context with role keywords."""
        text = (message.content.text if message.content else "").lower()
        role_keywords = {
            "role",
            "admin",
            "owner",
            "permission",
            "promote",
            "demote",
            "assign",
            "make",
        }
        has_keyword = any(kw in text for kw in role_keywords)

        # Require a group/server context (check for server_id on content)
        has_server = bool(
            getattr(message.content, "server_id", None)
            or getattr(message.content, "serverId", None)
        )
        channel_type = getattr(message.content, "channel_type", None) or getattr(
            message.content, "channelType", None
        )
        is_group = channel_type in ("GROUP", "WORLD", "group", "world")

        return has_keyword and (has_server or is_group)

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        entity_id = message.entity_id
        if entity_id is None:
            return ActionResult(
                text="Cannot update roles: no requesting entity specified.",
                success=False,
            )

        # Attempt to retrieve world metadata from runtime
        world_id: str | None = getattr(runtime, "world_id", None)
        if world_id is None:
            world_id_setting = getattr(runtime, "get_setting", lambda _: None)
            if callable(world_id_setting):
                world_id = world_id_setting("WORLD_ID")

        world: Any = None
        if world_id is not None:
            get_world = getattr(runtime, "get_world", None)
            if callable(get_world):
                world = await get_world(world_id)

        if world is None:
            msg = "Could not find the world. This action only works in a world."
            if callback:
                await callback(Content(text=msg, actions=["UPDATE_ROLE"]))
            return ActionResult(text=msg, success=False)

        # Read role metadata
        metadata: dict[str, Any] = getattr(world, "metadata", None) or {}
        roles: dict[str, str] = metadata.get("roles", {})

        requester_role = _parse_role(roles.get(str(entity_id), "NONE")) or Role.NONE

        # Parse the message for role assignments
        # Simple heuristic: look for patterns like "make <name> admin" or
        # "<name> -> OWNER", etc.
        text = message.content.text if message.content else ""
        assignments = _extract_assignments(text)

        if not assignments:
            msg = "No valid role assignments found in the request."
            if callback:
                await callback(Content(text=msg, actions=["UPDATE_ROLE"]))
            return ActionResult(
                text=msg,
                values={"success": False, "message": "No valid role assignments found"},
                success=False,
            )

        updated_roles: list[dict[str, str]] = []
        world_updated = False

        for target_name, new_role_str in assignments:
            new_role = _parse_role(new_role_str)
            if new_role is None:
                continue

            # Look up entity by name in room (simplified: use target_name as entity key)
            target_entity_id = _find_entity_id(target_name, roles)
            current_role = (
                _parse_role(roles.get(target_entity_id, "NONE")) if target_entity_id else None
            )

            if target_entity_id is None:
                if callback:
                    await callback(
                        Content(
                            text=f"Could not find entity '{target_name}'.",
                            actions=["UPDATE_ROLE"],
                        )
                    )
                continue

            if not _can_modify_role(requester_role, current_role, new_role):
                if callback:
                    await callback(
                        Content(
                            text=f"You don't have permission to change "
                            f"{target_name}'s role to {new_role.value}.",
                            actions=["UPDATE_ROLE"],
                        )
                    )
                continue

            roles[target_entity_id] = new_role.value
            world_updated = True
            updated_roles.append(
                {
                    "entityName": target_name,
                    "entityId": target_entity_id,
                    "newRole": new_role.value,
                }
            )

            if callback:
                await callback(
                    Content(
                        text=f"Updated {target_name}'s role to {new_role.value}.",
                        actions=["UPDATE_ROLE"],
                    )
                )

        # Persist world metadata if changed
        if world_updated:
            metadata["roles"] = roles
            if hasattr(world, "metadata"):
                world.metadata = metadata
            update_world = getattr(runtime, "update_world", None)
            if callable(update_world):
                await update_world(world)

        summary = (
            f"Successfully updated {len(updated_roles)} role(s)."
            if world_updated
            else "No roles were updated."
        )

        return ActionResult(
            text=summary,
            values={
                "success": world_updated,
                "totalProcessed": len(assignments),
                "totalUpdated": len(updated_roles),
            },
            data={
                "actionName": "UPDATE_ROLE",
                "updatedRoles": updated_roles,
            },
            success=world_updated,
        )

    @property
    def examples(self) -> list:
        return []


def _extract_assignments(text: str) -> list[tuple[str, str]]:
    """Simple heuristic extraction of role assignments from text.

    Looks for patterns like:
    - "make <name> admin"
    - "set <name> as owner"
    - "<name> -> ADMIN"
    """
    import re

    results: list[tuple[str, str]] = []
    role_names = {"owner", "admin", "none"}

    # Pattern: "make <name> (an) <role>"
    for m in re.finditer(r"\bmake\s+@?(\w+)\s+(?:an?\s+)?(\w+)", text, re.IGNORECASE):
        name, role = m.group(1), m.group(2).lower()
        if role in role_names:
            results.append((name, role.upper()))

    # Pattern: "set <name> as <role>"
    for m in re.finditer(r"\bset\s+@?(\w+)\s+as\s+(\w+)", text, re.IGNORECASE):
        name, role = m.group(1), m.group(2).lower()
        if role in role_names:
            results.append((name, role.upper()))

    # Pattern: "assign <role> to <name>"
    for m in re.finditer(r"\bassign\s+(\w+)\s+to\s+@?(\w+)", text, re.IGNORECASE):
        role, name = m.group(1).lower(), m.group(2)
        if role in role_names:
            results.append((name, role.upper()))

    # Pattern: "promote <name>"
    for m in re.finditer(r"\bpromote\s+@?(\w+)", text, re.IGNORECASE):
        results.append((m.group(1), "ADMIN"))

    return results


def _find_entity_id(name: str, roles: dict[str, str]) -> str | None:
    """Try to find an entity ID by name in the roles dict.

    In a full implementation this would query the runtime's entity store.
    Here we do a simple name-based lookup against known role keys.
    """
    name_lower = name.lower()
    for entity_id in roles:
        if name_lower in entity_id.lower():
            return entity_id
    # If not found in existing roles, use the name as a placeholder ID
    # (the caller should ideally resolve via runtime.get_entities_for_room)
    return name


_inst = UpdateRoleAction()

update_role_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
