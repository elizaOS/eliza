from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("SEND_MESSAGE")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
    if not isinstance(spec_examples, list):
        return []
    result: list[list[ActionExample]] = []
    for example in spec_examples:
        if not isinstance(example, list):
            continue
        row: list[ActionExample] = []
        for msg in example:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", {})
            text = ""
            actions: list[str] | None = None
            if isinstance(content, dict):
                text_val = content.get("text", "")
                text = str(text_val) if text_val else ""
                actions_val = content.get("actions")
                if isinstance(actions_val, list) and all(isinstance(a, str) for a in actions_val):
                    actions = list(actions_val)
            row.append(
                ActionExample(
                    name=str(msg.get("name", "")),
                    content=Content(text=text, actions=actions),
                )
            )
        if row:
            result.append(row)
    return result


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
        message_text = ""
        if responses and responses[0].content:
            message_text = str(responses[0].content.text or "")

        if not message_text:
            return ActionResult(
                text="No message content to send",
                values={"success": False, "error": "no_content"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        from uuid import UUID as StdUUID

        target_room_id_val: str | None = str(message.room_id) if message.room_id else None
        target_entity_id: str | None = None

        if message.content and message.content.target:
            target = message.content.target
            if isinstance(target, dict):
                room_str = target.get("roomId")
                entity_str = target.get("entityId")
                if room_str:
                    with contextlib.suppress(ValueError):
                        target_room_id_val = str(StdUUID(str(room_str)))
                if entity_str:
                    with contextlib.suppress(ValueError):
                        target_entity_id = str(StdUUID(str(entity_str)))

        if not target_room_id_val:
            return ActionResult(
                text="No target room specified",
                values={"success": False, "error": "no_target"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        message_content = Content(
            text=message_text,
            source="agent",
            actions=["SEND_MESSAGE"],
        )

        await runtime.create_memory(
            content=message_content,
            room_id=target_room_id_val,
            entity_id=runtime.agent_id,
            memory_type="message",
            metadata={
                "type": "SEND_MESSAGE",
                "targetEntityId": str(target_entity_id) if target_entity_id else None,
            },
        )

        response_content = Content(
            text=f"Message sent: {message_text[:50]}...",
            actions=["SEND_MESSAGE"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text="Message sent to room",
            values={
                "success": True,
                "messageSent": True,
                "targetRoomId": str(target_room_id_val),
                "targetEntityId": str(target_entity_id) if target_entity_id else None,
            },
            data={
                "actionName": "SEND_MESSAGE",
                "targetRoomId": str(target_room_id_val),
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
