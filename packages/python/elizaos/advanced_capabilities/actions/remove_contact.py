from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import REMOVE_CONTACT_TEMPLATE
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
_spec = require_action_spec("REMOVE_CONTACT")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class RemoveContactAction:
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
            template=REMOVE_CONTACT_TEMPLATE,
        )

        response = await runtime.use_model(ModelType.TEXT_SMALL, {"prompt": prompt})
        parsed = parse_key_value_xml(response)

        if not parsed or not parsed.get("contactName"):
            return ActionResult(
                text="Could not determine which contact to remove",
                success=False,
                values={"error": True},
                data={"error": "No contact name provided"},
            )

        contact_name = str(parsed.get("contactName", ""))
        confirmed = str(parsed.get("confirmed", "no")).lower() == "yes"

        if not confirmed:
            response_text = (
                f'To remove {contact_name}, please confirm by saying "yes, remove {contact_name}".'
            )
            if callback:
                await callback(Content(text=response_text, actions=["REMOVE_CONTACT"]))
            return ActionResult(
                text=response_text,
                success=True,
                values={"needsConfirmation": True},
                data={"contactName": contact_name},
            )

        contacts = await rolodex_service.search_contacts(search_term=contact_name)

        if not contacts:
            return ActionResult(
                text=f"Could not find a contact named '{contact_name}'",
                success=False,
                values={"error": True},
                data={"error": "Contact not found"},
            )

        contact = contacts[0]
        removed = await rolodex_service.remove_contact(contact.entity_id)

        if removed:
            response_text = f"I've removed {contact_name} from your contacts."
            if callback:
                await callback(Content(text=response_text, actions=["REMOVE_CONTACT"]))
            return ActionResult(
                text=response_text,
                success=True,
                values={"contactId": str(contact.entity_id)},
                data={"success": True},
            )
        else:
            return ActionResult(
                text="Failed to remove contact",
                success=False,
                values={"error": True},
                data={"error": "Remove operation failed"},
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


remove_contact_action = Action(
    name=RemoveContactAction.name,
    similes=RemoveContactAction().similes,
    description=RemoveContactAction.description,
    validate=RemoveContactAction().validate,
    handler=RemoveContactAction().handler,
    examples=RemoveContactAction().examples,
)
