from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import SCHEDULE_FOLLOW_UP_TEMPLATE
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
_spec = require_action_spec("SCHEDULE_FOLLOW_UP")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class ScheduleFollowUpAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
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

        scheduled_at = datetime.fromisoformat(scheduled_at_str.replace("Z", "+00:00"))

        from uuid import UUID as StdUUID

        entity_id = message.entity_id
        entity_id_uuid = StdUUID(str(entity_id)) if entity_id else None
        if entity_id_uuid:
            await follow_up_service.schedule_follow_up(
                entity_id=entity_id_uuid,
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

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


schedule_follow_up_action = Action(
    name=ScheduleFollowUpAction.name,
    similes=ScheduleFollowUpAction().similes,
    description=ScheduleFollowUpAction.description,
    validate=ScheduleFollowUpAction().validate,
    handler=ScheduleFollowUpAction().handler,
    examples=ScheduleFollowUpAction().examples,
)
