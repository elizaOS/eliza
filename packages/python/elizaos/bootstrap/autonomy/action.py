from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING

from elizaos.types.components import Action, ActionResult, HandlerOptions
from elizaos.types.memory import Memory
from elizaos.types.primitives import UUID, Content, as_uuid

from .service import AUTONOMY_SERVICE_TYPE, AutonomyService

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


ADMIN_KEYWORDS = (
    "admin",
    "user",
    "tell",
    "notify",
    "inform",
    "update",
    "message",
    "send",
    "communicate",
    "report",
    "alert",
)


async def _validate_send_to_admin(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        return False

    autonomous_room_id = autonomy_service.get_autonomous_room_id()
    if not autonomous_room_id or message.room_id != autonomous_room_id:
        return False

    admin_user_id = runtime.get_setting("ADMIN_USER_ID")
    if not admin_user_id:
        return False

    text = (message.content.text or "").lower() if message.content else ""
    if not text:
        return False
    return any(keyword in text for keyword in ADMIN_KEYWORDS)


async def _handle_send_to_admin(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[None]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        return ActionResult(
            success=False,
            text="Autonomy service not available",
            data={"error": "Service unavailable"},
        )

    autonomous_room_id = autonomy_service.get_autonomous_room_id()
    if not autonomous_room_id or message.room_id != autonomous_room_id:
        return ActionResult(
            success=False,
            text="Send to admin only available in autonomous context",
            data={"error": "Invalid context"},
        )

    admin_user_id = runtime.get_setting("ADMIN_USER_ID")
    if not admin_user_id:
        return ActionResult(
            success=False,
            text="No admin user configured. Set ADMIN_USER_ID in settings.",
            data={"error": "No admin configured"},
        )

    admin_messages = await runtime.get_memories(
        {
            "roomId": runtime.agent_id,
            "count": 10,
            "tableName": "memories",
        }
    )

    target_room_id: UUID
    if admin_messages and len(admin_messages) > 0:
        target_room_id = admin_messages[-1].room_id or runtime.agent_id
    else:
        target_room_id = runtime.agent_id

    autonomous_thought = message.content.text or "" if message.content else ""

    if "completed" in autonomous_thought or "finished" in autonomous_thought:
        message_to_admin = (
            f"I've completed a task and wanted to update you. My thoughts: {autonomous_thought}"
        )
    elif (
        "problem" in autonomous_thought
        or "issue" in autonomous_thought
        or "error" in autonomous_thought
    ):
        message_to_admin = (
            f"I encountered something that might need your attention: {autonomous_thought}"
        )
    elif "question" in autonomous_thought or "unsure" in autonomous_thought:
        message_to_admin = (
            f"I have a question and would appreciate your guidance: {autonomous_thought}"
        )
    else:
        message_to_admin = f"Autonomous update: {autonomous_thought}"

    current_time_ms = int(time.time() * 1000)
    admin_message = Memory(
        id=as_uuid(str(uuid.uuid4())),
        entity_id=runtime.agent_id,
        room_id=target_room_id,
        content=Content(
            text=message_to_admin,
            source="autonomy-to-admin",
            metadata={
                "type": "autonomous-to-admin-message",
                "originalThought": autonomous_thought,
                "timestamp": current_time_ms,
            },
        ),
        created_at=current_time_ms,
    )

    await runtime.create_memory(admin_message, "memories")

    success_message = f"Message sent to admin in room {str(target_room_id)[:8]}..."

    if callback:
        await callback(
            Content(
                text=success_message,
                data={
                    "adminUserId": str(admin_user_id),
                    "targetRoomId": str(target_room_id),
                    "messageContent": message_to_admin,
                },
            )
        )

    return ActionResult(
        success=True,
        text=success_message,
        data={
            "adminUserId": str(admin_user_id),
            "targetRoomId": str(target_room_id),
            "messageContent": message_to_admin,
            "sent": True,
        },
    )


send_to_admin_action = Action(
    name="SEND_TO_ADMIN",
    description="Send a message directly to the admin user from autonomous context",
    examples=[
        [
            {
                "name": "Agent",
                "content": {
                    "text": "I need to update the admin about my progress on the task.",
                    "action": "SEND_TO_ADMIN",
                },
            },
            {
                "name": "Agent",
                "content": {
                    "text": "Message sent to admin successfully.",
                },
            },
        ],
    ],
    validate=_validate_send_to_admin,
    handler=_handle_send_to_admin,
)
