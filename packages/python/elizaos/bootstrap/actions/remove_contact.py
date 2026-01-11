"""
REMOVE_CONTACT Action - Remove a contact from the rolodex.

This action removes a contact from the rolodex.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


REMOVE_CONTACT_TEMPLATE = """# Remove Contact from Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact removal information from the message:
1. Who to remove (name or entity reference)
2. Confirmation of the intent to remove

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to remove</contactName>
<confirmed>yes or no</confirmed>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


@dataclass
class RemoveContactAction:
    """Action that removes a contact from the rolodex."""

    name: str = "REMOVE_CONTACT"
    similes: list[str] = field(
        default_factory=lambda: [
            "DELETE_CONTACT",
            "REMOVE_FROM_ROLODEX",
            "DELETE_FROM_CONTACTS",
        ]
    )
    description: str = "Removes a contact from the rolodex"

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        """Validate if the action can be executed."""
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
        """Remove a contact from the rolodex."""
        from elizaos.bootstrap.services.rolodex import RolodexService

        rolodex_service = runtime.get_service("rolodex")
        if not rolodex_service or not isinstance(rolodex_service, RolodexService):
            return ActionResult(
                text="Rolodex service not available",
                success=False,
                values={"error": True},
                data={"error": "RolodexService not available"},
            )

        try:
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
                response_text = f'To remove {contact_name}, please confirm by saying "yes, remove {contact_name}".'
                if callback:
                    await callback(Content(text=response_text, actions=["REMOVE_CONTACT"]))
                return ActionResult(
                    text=response_text,
                    success=True,
                    values={"needsConfirmation": True},
                    data={"contactName": contact_name},
                )

            # Search for and remove the contact
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

        except Exception as e:
            runtime.logger.error(
                {"src": "action:remove_contact", "error": str(e)},
                "Error removing contact",
            )
            return ActionResult(
                text=f"Error removing contact: {e}",
                success=False,
                values={"error": True},
                data={"error": str(e)},
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions."""
        return [
            [
                ActionExample(
                    name="{{name1}}", content=Content(text="Remove John Doe from my contacts")
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text='To remove John Doe, please confirm by saying "yes, remove John Doe".',
                        actions=["REMOVE_CONTACT"],
                    ),
                ),
            ],
        ]


# Create the action instance
remove_contact_action = Action(
    name=RemoveContactAction.name,
    similes=RemoveContactAction().similes,
    description=RemoveContactAction.description,
    validate=RemoveContactAction().validate,
    handler=RemoveContactAction().handler,
    examples=RemoveContactAction().examples,
)
