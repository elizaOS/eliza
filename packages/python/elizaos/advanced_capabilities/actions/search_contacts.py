from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import SEARCH_CONTACTS_TEMPLATE
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
_spec = require_action_spec("SEARCH_CONTACTS")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class SearchContactsAction:
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

        state = await runtime.compose_state(message, ["RECENT_MESSAGES"])

        prompt = runtime.compose_prompt_from_state(
            state=state,
            template=SEARCH_CONTACTS_TEMPLATE,
        )

        response = await runtime.use_model(ModelType.TEXT_SMALL, {"prompt": prompt})
        parsed = parse_key_value_xml(response)

        categories = None
        tags = None
        search_term = None

        if parsed:
            if parsed.get("categories"):
                categories = [c.strip() for c in str(parsed["categories"]).split(",") if c.strip()]
            if parsed.get("searchTerm"):
                search_term = str(parsed["searchTerm"])
            if parsed.get("tags"):
                tags = [t.strip() for t in str(parsed["tags"]).split(",") if t.strip()]

        contacts = await rolodex_service.search_contacts(
            categories=categories,
            tags=tags,
            search_term=search_term,
        )

        contact_details: list[dict[str, str]] = []
        for contact in contacts:
            entity = await runtime.get_entity(str(contact.entity_id))
            name = entity.name if entity and entity.name else "Unknown"
            contact_details.append(
                {
                    "id": str(contact.entity_id),
                    "name": name,
                    "categories": ",".join(contact.categories),
                    "tags": ",".join(contact.tags),
                }
            )

        if not contact_details:
            response_text = "No contacts found matching your criteria."
        else:
            response_text = f"I found {len(contact_details)} contact(s):\n"
            for detail in contact_details:
                response_text += f"- {detail['name']}"
                if detail["categories"]:
                    response_text += f" [{detail['categories']}]"
                response_text += "\n"

        if callback:
            await callback(Content(text=response_text.strip(), actions=["SEARCH_CONTACTS"]))

        return ActionResult(
            text=response_text.strip(),
            success=True,
            values={
                "count": len(contact_details),
            },
            data={
                "count": len(contact_details),
            },
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


search_contacts_action = Action(
    name=SearchContactsAction.name,
    similes=SearchContactsAction().similes,
    description=SearchContactsAction.description,
    validate=SearchContactsAction().validate,
    handler=SearchContactsAction().handler,
    examples=SearchContactsAction().examples,
)
