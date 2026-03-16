from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import ADD_CONTACT_TEMPLATE
from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)
from elizaos.utils.spec_examples import convert_spec_examples

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

# Get text content from centralized specs
_spec = require_action_spec("ADD_CONTACT")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class AddContactAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        rolodex_service = runtime.get_service("rolodex")
        return rolodex_service is not None

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        from elizaos.bootstrap.services.rolodex import ContactPreferences, RolodexService

        rolodex_service = runtime.get_service("rolodex")
        if not rolodex_service or not isinstance(rolodex_service, RolodexService):
            return ActionResult(
                text="Rolodex service not available",
                success=False,
                values={"error": True},
                data={"error": "RolodexService not available"},
            )

        state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ENTITIES"])

        prompt = runtime.compose_prompt_from_state(
            state=state,
            template=ADD_CONTACT_TEMPLATE,
        )

        response = await runtime.use_model(ModelType.TEXT_SMALL, {"prompt": prompt})
        parsed = parse_key_value_xml(response)

        if not parsed or not parsed.get("contactName"):
            return ActionResult(
                text="Could not extract contact information",
                success=False,
                values={"error": True},
                data={"error": "Failed to parse contact info"},
            )

        contact_name = str(parsed.get("contactName", ""))
        categories_str = str(parsed.get("categories", "acquaintance"))
        categories = [c.strip() for c in categories_str.split(",") if c.strip()]
        notes = str(parsed.get("notes", ""))
        reason = str(parsed.get("reason", ""))

        from uuid import UUID as StdUUID

        entity_id = message.entity_id
        entity_id_uuid = StdUUID(str(entity_id)) if entity_id else None
        preferences = ContactPreferences(notes=notes) if notes else None

        if entity_id_uuid:
            await rolodex_service.add_contact(
                entity_id=entity_id_uuid,
                categories=categories,
                preferences=preferences,
            )

        response_text = (
            f"I've added {contact_name} to your contacts as {', '.join(categories)}. {reason}"
        )

        if callback:
            await callback(Content(text=response_text, actions=["ADD_CONTACT"]))

        return ActionResult(
            text=response_text,
            success=True,
            values={
                "contactId": str(entity_id),
                "contactName": contact_name,
                "categoriesStr": ",".join(categories),
            },
            data={
                "contactId": str(entity_id),
                "contactName": contact_name,
                "categories": ",".join(categories),
            },
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


add_contact_action = Action(
    name=AddContactAction.name,
    similes=AddContactAction().similes,
    description=AddContactAction.description,
    validate=AddContactAction().validate,
    handler=AddContactAction().handler,
    examples=AddContactAction().examples,
)
