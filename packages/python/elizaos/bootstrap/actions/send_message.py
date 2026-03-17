from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content
from elizaos.types.memory import Memory as MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("SEND_MESSAGE")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
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


@dataclass
class SendMessageAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        if message.content and message.content.target:
            return True
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        import time
        import uuid as uuid_module
        from types import SimpleNamespace

        from elizaos.types.primitives import as_uuid

        # Extract parameters from options
        params: dict[str, object] = {}
        if options and hasattr(options, "parameters") and isinstance(options.parameters, dict):
            params = options.parameters

        # Get message text from responses or options parameters
        message_text = ""
        if responses and responses[0].content:
            message_text = str(responses[0].content.text or "")
        if not message_text:
            message_text = str(params.get("text", ""))

        if not message_text:
            return ActionResult(
                text="No message content to send",
                values={"success": False, "error": "no_content"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        target_type = str(params.get("targetType", ""))
        target_value = str(params.get("target", ""))
        source = str(params.get("source", ""))
        target_room_id = message.room_id
        target_entity_id: UUID | object | None = None

        if target_type == "room" and target_value:
            with contextlib.suppress(ValueError):
                target_room_id = as_uuid(target_value)
        elif target_type == "user" and target_value:
            # Resolve user target by searching entities in the room
            entities = await runtime.get_entities_for_room(message.room_id)
            lowered = target_value.lower()
            for entity in entities:
                names = getattr(entity, "names", [])
                if any(lowered == n.lower() for n in names):
                    target_entity_id = entity.id
                    break

        # Fallback to message.content.target
        if not target_type and message.content and message.content.target:
            target = message.content.target
            if isinstance(target, dict):
                room_str = target.get("roomId")
                entity_str = target.get("entityId")
                if room_str:
                    with contextlib.suppress(ValueError):
                        target_room_id = UUID(room_str)
                if entity_str:
                    with contextlib.suppress(ValueError):
                        target_entity_id = UUID(entity_str)

        if not target_room_id:
            return ActionResult(
                text="No target room specified",
                values={"success": False, "error": "no_target"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        message_content = Content(
            text=message_text,
            source=source or "agent",
            actions=["SEND_MESSAGE"],
        )

        message_memory = MemoryType(
            id=as_uuid(str(uuid_module.uuid4())),
            entity_id=runtime.agent_id,
            room_id=target_room_id,
            content=message_content,
            created_at=int(time.time() * 1000),
        )

        await runtime.create_memory(
            content=message_content,
            room_id=target_room_id,
            entity_id=runtime.agent_id,
            memory_type="message",
            metadata={
                "type": "SEND_MESSAGE",
                "targetEntityId": str(target_entity_id) if target_entity_id else None,
            },
        )

        # Send message to target
        send_target = SimpleNamespace(
            room_id=target_room_id,
            entity_id=target_entity_id,
            source=source or "agent",
        )
        await runtime.send_message_to_target(send_target)

        response_content = Content(
            text=f"Message sent: {message_text[:50]}...",
            actions=["SEND_MESSAGE"],
        )

        if callback:
            await callback(response_content)

        result_values: dict[str, object] = {
            "success": True,
            "messageSent": True,
            "targetRoomId": str(target_room_id),
        }
        if target_type:
            result_values["targetType"] = target_type
        if target_entity_id:
            result_values["targetEntityId"] = target_entity_id

        return ActionResult(
            text="Message sent to room",
            values=result_values,
            data={
                "actionName": "SEND_MESSAGE",
                "targetRoomId": str(target_room_id),
                "messagePreview": message_text[:100],
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


send_message_action = Action(
    name=SendMessageAction.name,
    similes=SendMessageAction().similes,
    description=SendMessageAction.description,
    validate=SendMessageAction().validate,
    handler=SendMessageAction().handler,
    examples=SendMessageAction().examples,
)
