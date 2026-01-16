from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import UPDATE_CONTACT_TEMPLATE
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
_spec = require_action_spec("UPDATE_CONTACT")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class UpdateContactAction:
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
        from elizaos.bootstrap.services.rolodex import RolodexService

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
            template=UPDATE_CONTACT_TEMPLATE,
        )

        response = await runtime.use_model(ModelType.TEXT_SMALL, {"prompt": prompt})
        parsed = parse_key_value_xml(response)

        if not parsed or not parsed.get("contactName"):
            return ActionResult(
                text="Could not determine which contact to update",
                success=False,
                values={"error": True},
                data={"error": "No contact name provided"},
            )

        contact_name = str(parsed.get("contactName", ""))
        operation = str(parsed.get("operation", "replace"))

        contacts = await rolodex_service.search_contacts(search_term=contact_name)

        if not contacts:
            return ActionResult(
                text=f"Could not find a contact named '{contact_name}'",
                success=False,
                values={"error": True},
                data={"error": "Contact not found"},
            )

        contact = contacts[0]

        categories = None
        tags = None

        if parsed.get("categories"):
            new_categories = [c.strip() for c in str(parsed["categories"]).split(",") if c.strip()]
            if operation == "add_to" and contact.categories:
                categories = list(set(contact.categories + new_categories))
            else:
                categories = new_categories

        if parsed.get("tags"):
            new_tags = [t.strip() for t in str(parsed["tags"]).split(",") if t.strip()]
            if operation == "add_to" and contact.tags:
                tags = list(set(contact.tags + new_tags))
            else:
                tags = new_tags

        updated = await rolodex_service.update_contact(
            entity_id=contact.entity_id,
            categories=categories,
            tags=tags,
        )

        if updated:
            response_text = f"I've updated {contact_name}'s contact information."
            if categories:
                response_text += f" Categories: {', '.join(categories)}."
            if tags:
                response_text += f" Tags: {', '.join(tags)}."

            if callback:
                await callback(Content(text=response_text, actions=["UPDATE_CONTACT"]))

            return ActionResult(
                text=response_text,
                success=True,
                values={
                    "contactId": str(contact.entity_id),
                    "categoriesStr": ",".join(categories) if categories else "",
                    "tagsStr": ",".join(tags) if tags else "",
                },
                data={"success": True},
            )
        else:
            return ActionResult(
                text="Failed to update contact",
                success=False,
                values={"error": True},
                data={"error": "Update operation failed"},
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


update_contact_action = Action(
    name=UpdateContactAction.name,
    similes=UpdateContactAction().similes,
    description=UpdateContactAction.description,
    validate=UpdateContactAction().validate,
    handler=UpdateContactAction().handler,
    examples=UpdateContactAction().examples,
)
