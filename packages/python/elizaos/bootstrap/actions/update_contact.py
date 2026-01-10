"""
UPDATE_CONTACT Action - Update a contact in the rolodex.

This action updates an existing contact's information.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

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


UPDATE_CONTACT_TEMPLATE = """# Update Contact Information

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact update information from the message:
1. Who to update (name or entity reference)
2. What fields to update (categories, tags, preferences, notes)
3. Whether to add to or replace existing values

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to update</contactName>
<operation>add_to or replace</operation>
<categories>comma-separated list of categories</categories>
<tags>comma-separated list of tags</tags>
<notes>Any additional notes</notes>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


@dataclass
class UpdateContactAction:
    """Action that updates a contact in the rolodex."""

    name: str = "UPDATE_CONTACT_INFO"
    similes: list[str] = field(
        default_factory=lambda: [
            "EDIT_CONTACT",
            "MODIFY_CONTACT",
            "CHANGE_CONTACT_INFO",
        ]
    )
    description: str = "Updates an existing contact in the rolodex"

    async def validate(self, runtime: IAgentRuntime) -> bool:
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
        """Update a contact in the rolodex."""
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

            # Search for the contact
            contacts = await rolodex_service.search_contacts(search_term=contact_name)

            if not contacts:
                return ActionResult(
                    text=f"Could not find a contact named '{contact_name}'",
                    success=False,
                    values={"error": True},
                    data={"error": "Contact not found"},
                )

            contact = contacts[0]

            # Prepare updates
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

            # Update the contact
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
                    await callback(Content(text=response_text, actions=["UPDATE_CONTACT_INFO"]))

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

        except Exception as e:
            runtime.logger.error(
                {"src": "action:update_contact", "error": str(e)},
                "Error updating contact",
            )
            return ActionResult(
                text=f"Error updating contact: {e}",
                success=False,
                values={"error": True},
                data={"error": str(e)},
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions."""
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Update John Doe and add the tech tag")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I've updated John Doe's contact information. Tags: tech.",
                        actions=["UPDATE_CONTACT_INFO"],
                    ),
                ),
            ],
        ]


# Create the action instance
update_contact_action = Action(
    name=UpdateContactAction.name,
    similes=UpdateContactAction().similes,
    description=UpdateContactAction.description,
    validate=UpdateContactAction().validate,
    handler=UpdateContactAction().handler,
    examples=UpdateContactAction().examples,
)

