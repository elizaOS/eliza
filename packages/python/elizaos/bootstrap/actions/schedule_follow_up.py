"""
SCHEDULE_FOLLOW_UP Action - Schedule a follow-up reminder.

This action schedules a follow-up reminder for a contact.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
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


SCHEDULE_FOLLOW_UP_TEMPLATE = """# Schedule Follow-up

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})
Current Date/Time: {{currentDateTime}}

## Instructions
Extract the follow-up scheduling information from the message:
1. Who to follow up with (name or entity reference)
2. When to follow up (date/time or relative time like "tomorrow", "next week")
3. Reason for the follow-up
4. Priority (high, medium, low)

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to follow up with</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<scheduledAt>ISO datetime for the follow-up</scheduledAt>
<reason>Reason for the follow-up</reason>
<priority>high, medium, or low</priority>
<message>Optional message or notes for the follow-up</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


@dataclass
class ScheduleFollowUpAction:
    """Action that schedules a follow-up reminder."""

    name: str = "SCHEDULE_FOLLOW_UP"
    similes: list[str] = field(
        default_factory=lambda: [
            "follow up with",
            "remind me to contact",
            "schedule a check-in",
            "set a reminder for",
        ]
    )
    description: str = "Schedule a follow-up reminder for a contact"

    async def validate(self, runtime: IAgentRuntime) -> bool:
        """Validate if the action can be executed."""
        rolodex_service = runtime.get_service("rolodex")
        follow_up_service = runtime.get_service("follow_up")
        return rolodex_service is not None and follow_up_service is not None

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        """Schedule a follow-up with a contact."""
        from elizaos.bootstrap.services.follow_up import FollowUpService
        from elizaos.bootstrap.services.rolodex import RolodexService

        rolodex_service = runtime.get_service("rolodex")
        follow_up_service = runtime.get_service("follow_up")

        if not rolodex_service or not isinstance(rolodex_service, RolodexService):
            return ActionResult(
                text="Rolodex service not available",
                success=False,
                values={"error": True},
                data={"error": "RolodexService not available"},
            )

        if not follow_up_service or not isinstance(follow_up_service, FollowUpService):
            return ActionResult(
                text="Follow-up service not available",
                success=False,
                values={"error": True},
                data={"error": "FollowUpService not available"},
            )

        try:
            state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ENTITIES"])
            state.values["currentDateTime"] = datetime.utcnow().isoformat()

            prompt = runtime.compose_prompt_from_state(
                state=state,
                template=SCHEDULE_FOLLOW_UP_TEMPLATE,
            )

            response = await runtime.use_model(ModelType.TEXT_SMALL, {"prompt": prompt})
            parsed = parse_key_value_xml(response)

            if not parsed or not parsed.get("contactName"):
                return ActionResult(
                    text="Could not extract follow-up information",
                    success=False,
                    values={"error": True},
                    data={"error": "Failed to parse follow-up info"},
                )

            contact_name = str(parsed.get("contactName", ""))
            scheduled_at_str = str(parsed.get("scheduledAt", ""))
            reason = str(parsed.get("reason", "Follow-up"))
            priority = str(parsed.get("priority", "medium"))
            follow_up_message = str(parsed.get("message", ""))

            # Parse scheduled time
            try:
                scheduled_at = datetime.fromisoformat(scheduled_at_str.replace("Z", "+00:00"))
            except Exception:
                return ActionResult(
                    text="Invalid follow-up date/time",
                    success=False,
                    values={"error": True},
                    data={"error": "Invalid datetime"},
                )

            # Schedule the follow-up
            entity_id = message.entity_id
            task = await follow_up_service.schedule_follow_up(
                entity_id=entity_id,
                scheduled_at=scheduled_at,
                reason=reason,
                priority=priority,
                message=follow_up_message,
            )

            response_text = f"I've scheduled a follow-up with {contact_name} for {scheduled_at.strftime('%B %d, %Y')}. Reason: {reason}"

            if callback:
                await callback(Content(text=response_text, actions=["SCHEDULE_FOLLOW_UP"]))

            return ActionResult(
                text=response_text,
                success=True,
                values={
                    "contactId": str(entity_id),
                    "scheduledAt": scheduled_at.isoformat(),
                },
                data={
                    "contactId": str(entity_id),
                    "contactName": contact_name,
                    "scheduledAt": scheduled_at.isoformat(),
                    "reason": reason,
                    "priority": priority,
                },
            )

        except Exception as e:
            runtime.logger.error(
                {"src": "action:schedule_follow_up", "error": str(e)},
                "Error scheduling follow-up",
            )
            return ActionResult(
                text=f"Error scheduling follow-up: {e}",
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
                    name="{{name1}}",
                    content=Content(text="Remind me to follow up with John next week"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I've scheduled a follow-up with John for next week.",
                        actions=["SCHEDULE_FOLLOW_UP"],
                    ),
                ),
            ],
        ]


# Create the action instance
schedule_follow_up_action = Action(
    name=ScheduleFollowUpAction.name,
    similes=ScheduleFollowUpAction().similes,
    description=ScheduleFollowUpAction.description,
    validate=ScheduleFollowUpAction().validate,
    handler=ScheduleFollowUpAction().handler,
    examples=ScheduleFollowUpAction().examples,
)
