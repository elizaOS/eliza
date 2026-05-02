from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID as StdUUID

from elizaos.deterministic import get_prompt_reference_datetime
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import SCHEDULE_FOLLOW_UP_TEMPLATE
from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)
from elizaos.utils.xml import parse_key_value_xml

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
    spec_examples = cast(list[list[dict[str, Any]]], _spec.get("examples", []))
    if spec_examples:
        return [
            [
                ActionExample(
                    name=msg.get("name", ""),
                    content=Content(
                        text=msg.get("content", {}).get("text", ""),
                        actions=msg.get("content", {}).get("actions"),
                    ),
                )
                for msg in example
            ]
            for example in spec_examples
        ]
    return []


def _normalize_priority(raw_priority: str) -> str:
    normalized = raw_priority.strip().lower()
    if normalized in {"high", "medium", "low"}:
        return normalized
    return "medium"


def _coerce_uuid(value: object | None) -> StdUUID | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return StdUUID(text)
    except ValueError:
        return None


@dataclass
class ScheduleFollowUpAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        relationships_service = runtime.get_service("relationships")
        follow_up_service = runtime.get_service("follow_up")
        return relationships_service is not None and follow_up_service is not None

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        from elizaos.features.advanced_capabilities.services.follow_up import FollowUpService
        from elizaos.features.advanced_capabilities.services.relationships import (
            RelationshipsService,
        )

        relationships_service = runtime.get_service("relationships")
        follow_up_service = runtime.get_service("follow_up")

        if not relationships_service or not isinstance(relationships_service, RelationshipsService):
            return ActionResult(
                text="Relationships service not available",
                success=False,
                values={"error": True},
                data={"error": "RelationshipsService not available"},
            )

        if not follow_up_service or not isinstance(follow_up_service, FollowUpService):
            return ActionResult(
                text="Follow-up service not available",
                success=False,
                values={"error": True},
                data={"error": "FollowUpService not available"},
            )

        state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ENTITIES"])
        state.values["currentDateTime"] = get_prompt_reference_datetime(
            runtime,
            message,
            state,
            "action:schedule_follow_up",
        ).isoformat()

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
        priority = _normalize_priority(str(parsed.get("priority", "medium")))
        follow_up_message = str(parsed.get("message", ""))
        parsed_entity_id = _coerce_uuid(parsed.get("entityId"))
        message_entity_id = _coerce_uuid(message.entity_id)

        try:
            scheduled_at = datetime.fromisoformat(scheduled_at_str.replace("Z", "+00:00"))
        except ValueError:
            return ActionResult(
                text="Could not parse the follow-up date/time",
                success=False,
                values={"error": True},
                data={"error": "Invalid follow-up datetime"},
            )

        entity_id_uuid = parsed_entity_id or message_entity_id
        if entity_id_uuid is None and contact_name:
            contacts = await relationships_service.search_contacts(search_term=contact_name)
            if contacts:
                entity_id_uuid = contacts[0].entity_id

        if entity_id_uuid is None:
            return ActionResult(
                text=f"Could not determine which contact to schedule for ({contact_name}).",
                success=False,
                values={"error": True},
                data={"error": "Missing contact entity id"},
            )

        contact = await relationships_service.get_contact(entity_id_uuid)
        if contact is None:
            return ActionResult(
                text=f"Contact '{contact_name}' was not found in the relationships.",
                success=False,
                values={"error": True},
                data={"error": "Contact not found"},
            )

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
                "contactId": str(entity_id_uuid),
                "scheduledAt": scheduled_at.isoformat(),
            },
            data={
                "contactId": str(entity_id_uuid),
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
