from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import UPDATE_ENTITY_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType
from elizaos.utils.spec_examples import convert_spec_examples

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("UPDATE_ENTITY")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class UpdateEntityAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        return message.entity_id is not None

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
            raise ValueError("State is required for UPDATE_ENTITY action")

        entity_id = message.entity_id
        if not entity_id:
            return ActionResult(
                text="No entity specified to update",
                values={"success": False, "error": "no_entity_id"},
                data={"actionName": "UPDATE_ENTITY"},
                success=False,
            )

        entity = await runtime.get_entity(entity_id)
        if entity is None:
            return ActionResult(
                text="Entity not found",
                values={"success": False, "error": "entity_not_found"},
                data={"actionName": "UPDATE_ENTITY"},
                success=False,
            )

        state = await runtime.compose_state(
            message, ["RECENT_MESSAGES", "ACTION_STATE", "ENTITY_INFO"]
        )

        entity_info = f"""
Entity ID: {entity.id}
Name: {entity.name or "Unknown"}
Type: {entity.entity_type or "Unknown"}
"""
        if entity.metadata:
            entity_info += f"Metadata: {entity.metadata}"

        template = (
            runtime.character.templates.get("updateEntityTemplate")
            if runtime.character.templates and "updateEntityTemplate" in runtime.character.templates
            else UPDATE_ENTITY_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)
        prompt = prompt.replace("{{entityInfo}}", entity_info)

        response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response_text)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response")

        thought = str(parsed_xml.get("thought", ""))
        target_entity_id_str = str(parsed_xml.get("entity_id", str(entity_id)))

        target_entity_id = UUID(target_entity_id_str)

        updates_raw = parsed_xml.get("updates", {})
        updated_fields: list[str] = []

        if isinstance(updates_raw, dict):
            field_list = updates_raw.get("field", [])
            if isinstance(field_list, dict):
                field_list = [field_list]
            for field_update in field_list:
                if isinstance(field_update, dict):
                    field_name = str(field_update.get("name", ""))
                    field_value = str(field_update.get("value", ""))
                    if field_name and field_value:
                        if entity.metadata is None:
                            entity.metadata = {}
                        entity.metadata[field_name] = field_value
                        updated_fields.append(field_name)

        if not updated_fields:
            return ActionResult(
                text="No fields to update",
                values={"success": True, "noChanges": True},
                data={"actionName": "UPDATE_ENTITY", "thought": thought},
                success=True,
            )

        await runtime.update_entity(entity)

        response_content = Content(
            text=f"Updated entity fields: {', '.join(updated_fields)}",
            actions=["UPDATE_ENTITY"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Updated entity: {', '.join(updated_fields)}",
            values={
                "success": True,
                "entityUpdated": True,
                "entityId": str(target_entity_id),
                "updatedFields": ", ".join(updated_fields),
            },
            data={
                "actionName": "UPDATE_ENTITY",
                "entityId": str(target_entity_id),
                "updatedFields": updated_fields,
                "thought": thought,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


update_entity_action = Action(
    name=UpdateEntityAction.name,
    similes=UpdateEntityAction().similes,
    description=UpdateEntityAction.description,
    validate=UpdateEntityAction().validate,
    handler=UpdateEntityAction().handler,
    examples=UpdateEntityAction().examples,
)
