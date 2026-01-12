from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class SendMessageAction:
    name: str = "SEND_MESSAGE"
    similes: list[str] = field(
        default_factory=lambda: [
            "MESSAGE",
            "DM",
            "DIRECT_MESSAGE",
            "POST_MESSAGE",
            "NOTIFY",
        ]
    )
    description: str = (
        "Send a message to a specific room or entity. "
        "Use this for targeted communication outside the current context."
    )

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

        target_room_id = message.room_id
        target_entity_id: UUID | None = None

        if message.content and message.content.target:
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
            source="agent",
            actions=["SEND_MESSAGE"],
        )

        await runtime.create_memory(
            content=message_content,
            room_id=target_room_id,
            entity_id=runtime.agent_id,
            memory_type=MemoryType.MESSAGE,
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
                "targetRoomId": str(target_room_id),
                "targetEntityId": str(target_entity_id) if target_entity_id else None,
            },
            data={
                "actionName": "SEND_MESSAGE",
                "targetRoomId": str(target_room_id),
                "messagePreview": message_text[:100],
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Send a hello to the general channel."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll send that message now.",
                        actions=["SEND_MESSAGE"],
                    ),
                ),
            ],
        ]


send_message_action = Action(
    name=SendMessageAction.name,
    similes=SendMessageAction().similes,
    description=SendMessageAction.description,
    validate=SendMessageAction().validate,
    handler=SendMessageAction().handler,
    examples=SendMessageAction().examples,
)
