from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


class Role(str, Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    MEMBER = "MEMBER"
    GUEST = "GUEST"
    NONE = "NONE"


UPDATE_ROLE_TEMPLATE = """# Update entity role in the world.

{{providers}}

# Current Role Assignments:
{{#each roles}}
- {{this.entityId}}: {{this.role}}
{{/each}}

Valid roles: OWNER, ADMIN, MEMBER, GUEST, NONE

<response>
    <thought>Your reasoning for the role change</thought>
    <entity_id>The entity ID to update</entity_id>
    <new_role>The new role to assign (OWNER, ADMIN, MEMBER, GUEST, or NONE)</new_role>
</response>"""


@dataclass
class UpdateRoleAction:
    name: str = "UPDATE_ROLE"
    similes: list[str] = field(
        default_factory=lambda: [
            "ASSIGN_ROLE",
            "CHANGE_ROLE",
            "SET_ROLE",
            "MODIFY_PERMISSIONS",
            "GRANT_ROLE",
        ]
    )
    description: str = (
        "Update the role of an entity in a world. Use this to manage permissions and access levels."
    )

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        room_id = message.room_id
        if not room_id:
            return False

        room = await runtime.get_room(room_id)
        if room is None or room.world_id is None:
            return False

        world = await runtime.get_world(room.world_id)
        if world is None or world.metadata is None:
            return False

        roles = world.metadata.get("roles", {})
        agent_role = roles.get(str(runtime.agent_id), Role.NONE.value)

        return agent_role in (Role.OWNER.value, Role.ADMIN.value)

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if state is None:
            raise ValueError("State is required for UPDATE_ROLE action")

        room_id = message.room_id
        if not room_id:
            return ActionResult(
                text="No room context for role update",
                values={"success": False, "error": "no_room_id"},
                data={"actionName": "UPDATE_ROLE"},
                success=False,
            )

        room = await runtime.get_room(room_id)
        if room is None or room.world_id is None:
            return ActionResult(
                text="Room or world not found",
                values={"success": False, "error": "room_not_found"},
                data={"actionName": "UPDATE_ROLE"},
                success=False,
            )

        world = await runtime.get_world(room.world_id)
        if world is None or world.metadata is None:
            return ActionResult(
                text="World not found",
                values={"success": False, "error": "world_not_found"},
                data={"actionName": "UPDATE_ROLE"},
                success=False,
            )

        state = await runtime.compose_state(
            message, ["RECENT_MESSAGES", "ACTION_STATE", "WORLD_INFO"]
        )

        current_roles = world.metadata.get("roles", {})
        roles_context = "\n".join(
            f"- {entity_id}: {role}" for entity_id, role in current_roles.items()
        )

        template = (
            runtime.character.templates.get("updateRoleTemplate")
            if runtime.character.templates and "updateRoleTemplate" in runtime.character.templates
            else UPDATE_ROLE_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)
        prompt = prompt.replace("{{roles}}", roles_context)

        response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response_text)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response")

        thought = str(parsed_xml.get("thought", ""))
        entity_id_str = str(parsed_xml.get("entity_id", ""))
        new_role_str = str(parsed_xml.get("new_role", "")).upper()

        if not entity_id_str:
            raise ValueError("No entity ID provided")

        if new_role_str not in [r.value for r in Role]:
            raise ValueError(f"Invalid role: {new_role_str}")

        entity_id = UUID(entity_id_str)

        roles = dict(world.metadata.get("roles", {}))
        old_role = roles.get(str(entity_id), Role.NONE.value)
        roles[str(entity_id)] = new_role_str
        world.metadata["roles"] = roles

        await runtime.update_world(world)

        response_content = Content(
            text=f"Updated role for {entity_id_str}: {old_role} -> {new_role_str}",
            actions=["UPDATE_ROLE"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Role updated: {entity_id_str} is now {new_role_str}",
            values={
                "success": True,
                "roleUpdated": True,
                "entityId": str(entity_id),
                "oldRole": old_role,
                "newRole": new_role_str,
            },
            data={
                "actionName": "UPDATE_ROLE",
                "entityId": str(entity_id),
                "oldRole": old_role,
                "newRole": new_role_str,
                "thought": thought,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Make @user an admin in this server."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll update their role to admin.",
                        actions=["UPDATE_ROLE"],
                    ),
                ),
            ],
        ]


update_role_action = Action(
    name=UpdateRoleAction.name,
    similes=UpdateRoleAction().similes,
    description=UpdateRoleAction.description,
    validate=UpdateRoleAction().validate,
    handler=UpdateRoleAction().handler,
    examples=UpdateRoleAction().examples,
)
