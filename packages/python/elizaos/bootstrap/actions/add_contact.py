"""
ADD_CONTACT Action - Add a new contact to the rolodex.

This action adds a new contact with categorization and preferences.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)

from elizaos.bootstrap.utils.xml import parse_key_value_xml

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


ADD_CONTACT_TEMPLATE = """# Add Contact to Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact information from the message and determine:
1. Who should be added as a contact (name or entity reference)
2. What category they belong to (friend, family, colleague, acquaintance, vip, business)
3. Any preferences or notes mentioned

Respond with the extracted information in XML format.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to add</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<categories>comma-separated categories</categories>
<notes>Any additional notes or preferences</notes>
<reason>Reason for adding this contact</reason>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


@dataclass
class AddContactAction:
    """Action that adds a new contact to the rolodex."""

    name: str = "ADD_CONTACT"
    similes: list[str] = field(
        default_factory=lambda: [
            "add contact",
            "save contact",
            "add to contacts",
            "add to rolodex",
            "remember this person",
        ]
    )
    description: str = "Add a new contact to the rolodex with categorization and preferences"

    async def validate(self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None) -> bool:
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
        """Add a contact to the rolodex."""
        from elizaos.bootstrap.services.rolodex import RolodexService, ContactPreferences

        rolodex_service = runtime.get_service("rolodex")
        if not rolodex_service or not isinstance(rolodex_service, RolodexService):
            return ActionResult(
                text="Rolodex service not available",
                success=False,
                values={"error": True},
                data={"error": "RolodexService not available"},
            )

        try:
            # Compose state for prompt
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

            # Create contact
            entity_id = message.entity_id
            preferences = ContactPreferences(notes=notes) if notes else None

            await rolodex_service.add_contact(
                entity_id=entity_id,
                categories=categories,
                preferences=preferences,
            )

            response_text = f"I've added {contact_name} to your contacts as {', '.join(categories)}. {reason}"

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

        except Exception as e:
            runtime.logger.error(
                {"src": "action:add_contact", "error": str(e)},
                "Error adding contact",
            )
            return ActionResult(
                text=f"Error adding contact: {e}",
                success=False,
                values={"error": True},
                data={"error": str(e)},
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions."""
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Add John Smith to my contacts as a colleague")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(text="I've added John Smith to your contacts as a colleague.", actions=["ADD_CONTACT"]),
                ),
            ],
        ]


# Create the action instance
add_contact_action = Action(
    name=AddContactAction.name,
    similes=AddContactAction().similes,
    description=AddContactAction.description,
    validate=AddContactAction().validate,
    handler=AddContactAction().handler,
    examples=AddContactAction().examples,
)

