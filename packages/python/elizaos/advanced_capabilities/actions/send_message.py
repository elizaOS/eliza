from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content
from elizaos.types.memory import Memory as MemoryType
from elizaos.types.primitives import UUID, as_uuid

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("SEND_MESSAGE")


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


def _parse_uuid(value: object) -> UUID | None:
    if not isinstance(value, str) or not value.strip():
        return None
    with contextlib.suppress(Exception):
        return as_uuid(value.strip())
    return None


def _normalize_parameters(options: HandlerOptions | None) -> dict[str, Any]:
    raw = getattr(options, "parameters", None)
    if isinstance(raw, dict):
        return raw

    if raw is None:
        return {}

    if hasattr(raw, "items"):
        try:
            return {str(k): v for k, v in raw.items()}
        except Exception:
            return {}

    return {}


def _coerce_entity_name(entity: object) -> list[str]:
    if isinstance(entity, dict):
        names = entity.get("names")
        if isinstance(names, list):
            return [str(n).strip() for n in names if isinstance(n, str) and n.strip()]
        name = entity.get("name")
        if isinstance(name, str) and name.strip():
            return [name.strip()]
        return []

    names = getattr(entity, "names", None)
    if isinstance(names, list):
        clean = [str(n).strip() for n in names if isinstance(n, str) and str(n).strip()]
        if clean:
            return clean

    name = getattr(entity, "name", None)
    if isinstance(name, str) and name.strip():
        return [name.strip()]

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
        params = _normalize_parameters(options)

        text_param = params.get("text")
        message_text = str(text_param).strip() if isinstance(text_param, str) else ""
        if not message_text and responses and responses[0].content:
            message_text = str(responses[0].content.text or "").strip()
        if not message_text and message.content and isinstance(message.content.text, str):
            message_text = message.content.text.strip()

        if not message_text:
            return ActionResult(
                text="No message content to send",
                values={"success": False, "error": "no_content"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        target_room_id = message.room_id
        target_entity_id: UUID | None = None
        target_type = "room"

        target_type_param = params.get("targetType") or params.get("target_type")
        target_param = params.get("target")
        source_param = params.get("source")

        source = (
            source_param.strip()
            if isinstance(source_param, str) and source_param.strip()
            else (
                message.content.source
                if message.content and isinstance(message.content.source, str)
                else "agent"
            )
        )

        if isinstance(target_type_param, str):
            normalized_target_type = target_type_param.strip().lower()
            if normalized_target_type in {"user", "entity"}:
                target_type = "user"
            elif normalized_target_type == "room":
                target_type = "room"

        if isinstance(target_param, str) and target_param.strip():
            target_value = target_param.strip()
            if target_type == "room":
                parsed_room = _parse_uuid(target_value)
                if parsed_room:
                    target_room_id = parsed_room
                else:
                    world_id = None
                    room_data = (
                        getattr(getattr(state, "data", None), "room", None) if state else None
                    )
                    if room_data is not None:
                        world_id = getattr(room_data, "world_id", None) or getattr(
                            room_data, "worldId", None
                        )
                    if world_id is None:
                        with contextlib.suppress(Exception):
                            current_room = await runtime.get_room(message.room_id)
                            if current_room:
                                world_id = getattr(current_room, "world_id", None) or getattr(
                                    current_room, "worldId", None
                                )

                    if world_id is not None:
                        with contextlib.suppress(Exception):
                            rooms = await runtime.get_rooms(world_id)
                            for room in rooms:
                                room_name = getattr(room, "name", None)
                                if (
                                    isinstance(room_name, str)
                                    and room_name.strip().lower() == target_value.lower()
                                ):
                                    room_id = getattr(room, "id", None)
                                    if room_id is not None:
                                        target_room_id = as_uuid(str(room_id))
                                        break
            else:
                parsed_entity = _parse_uuid(target_value)
                if parsed_entity:
                    target_entity_id = parsed_entity
                else:
                    with contextlib.suppress(Exception):
                        entities = await runtime.get_entities_for_room(message.room_id)
                        for entity in entities:
                            names = _coerce_entity_name(entity)
                            if any(name.lower() == target_value.lower() for name in names):
                                entity_id = getattr(entity, "id", None)
                                if entity_id is not None:
                                    target_entity_id = as_uuid(str(entity_id))
                                    break

        if message.content and message.content.target:
            target = message.content.target
            if isinstance(target, dict):
                room_str = target.get("roomId")
                entity_str = target.get("entityId")
                if room_str and target_type == "room":
                    with contextlib.suppress(Exception):
                        target_room_id = as_uuid(room_str)
                if entity_str and target_type == "user":
                    with contextlib.suppress(Exception):
                        target_entity_id = as_uuid(entity_str)

        if not target_room_id:
            return ActionResult(
                text="No target room specified",
                values={"success": False, "error": "no_target"},
                data={"actionName": "SEND_MESSAGE"},
                success=False,
            )

        message_content = Content(
            text=message_text,
            source=source,
            actions=["SEND_MESSAGE"],
        )

        send_message_to_target = getattr(runtime, "send_message_to_target", None)
        if callable(send_message_to_target):
            with contextlib.suppress(Exception):
                from elizaos.types.runtime import TargetInfo

                await send_message_to_target(
                    TargetInfo(
                        roomId=str(target_room_id),
                        entityId=str(target_entity_id) if target_entity_id else None,
                        source=source,
                    ),
                    message_content,
                )

        # Create the message memory
        import time
        import uuid as uuid_module

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

        # Emit MESSAGE_SENT event
        await runtime.emit_event(
            "MESSAGE_SENT",
            {
                "runtime": runtime,
                "source": "send-message-action",
                "message": message_memory,
            },
        )

        response_content = Content(
            text=f"Message sent: {message_text[:50]}...",
            actions=["SEND_MESSAGE"],
        )

        if callback:
            await callback(response_content)

        target_id = (
            target_entity_id if target_type == "user" and target_entity_id else target_room_id
        )
        return ActionResult(
            text="Message sent",
            values={
                "success": True,
                "messageSent": True,
                "targetType": target_type,
                "target": str(target_id),
                "source": source,
                "targetRoomId": str(target_room_id),
                "targetEntityId": str(target_entity_id) if target_entity_id else None,
            },
            data={
                "actionName": "SEND_MESSAGE",
                "targetType": target_type,
                "target": str(target_id),
                "source": source,
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
