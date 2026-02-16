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
        ),
        created_at=current_time_ms,
    )

    await runtime.create_memory(admin_message, "memories")

    # Emit MESSAGE_SENT event after creating the admin message
    await runtime.emit_event(
        "MESSAGE_SENT",
        {
            "runtime": runtime,
            "source": "autonomy-to-admin",
            "message": admin_message,
        },
    )

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


# ── ENABLE_AUTONOMY / DISABLE_AUTONOMY actions ─────────────────────────


def _is_autonomy_running(runtime: IAgentRuntime) -> bool:
    """Return True if the autonomy loop is currently active."""
    svc = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if svc and isinstance(svc, AutonomyService):
        return svc.is_loop_running()
    return getattr(runtime, "enable_autonomy", False)


async def _validate_enable_autonomy(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Valid only when autonomy is currently paused / disabled."""
    return not _is_autonomy_running(runtime)


async def _validate_disable_autonomy(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Valid only when autonomy is currently running / enabled."""
    return _is_autonomy_running(runtime)


async def _handle_enable_autonomy(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[None]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Enable the autonomous loop."""
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)

    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        runtime.enable_autonomy = True
        result_text = "Autonomy enabled (runtime flag). The autonomy service is not running."
        if callback:
            await callback(Content(text=result_text))
        return ActionResult(success=True, text=result_text, data={"enabled": True})

    await autonomy_service.enable_autonomy()
    result_text = "Autonomy has been enabled."
    if callback:
        await callback(Content(text=result_text))
    return ActionResult(success=True, text=result_text, data={"enabled": True})


async def _handle_disable_autonomy(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[None]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Disable the autonomous loop."""
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)

    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        runtime.enable_autonomy = False
        result_text = "Autonomy disabled (runtime flag)."
        if callback:
            await callback(Content(text=result_text))
        return ActionResult(success=True, text=result_text, data={"enabled": False})

    await autonomy_service.disable_autonomy()
    result_text = "Autonomy has been disabled."
    if callback:
        await callback(Content(text=result_text))
    return ActionResult(success=True, text=result_text, data={"enabled": False})


enable_autonomy_action = Action(
    name="ENABLE_AUTONOMY",
    description=(
        "Enable the agent's autonomous operation. "
        "Use this when asked to start autonomy, go autonomous, or activate autonomous behavior. "
        "Only available when autonomy is currently paused."
    ),
    similes=["START_AUTONOMY", "ACTIVATE_AUTONOMY", "GO_AUTONOMOUS"],
    examples=[
        [
            {
                "name": "User",
                "content": {"text": "Enable autonomy"},
            },
            {
                "name": "Agent",
                "content": {
                    "text": "Autonomy has been enabled.",
                    "action": "ENABLE_AUTONOMY",
                },
            },
        ],
        [
            {
                "name": "User",
                "content": {"text": "Go autonomous"},
            },
            {
                "name": "Agent",
                "content": {
                    "text": "Autonomy has been enabled.",
                    "action": "ENABLE_AUTONOMY",
                },
            },
        ],
    ],
    validate=_validate_enable_autonomy,
    handler=_handle_enable_autonomy,
)


disable_autonomy_action = Action(
    name="DISABLE_AUTONOMY",
    description=(
        "Disable the agent's autonomous operation. "
        "Use this when asked to stop, pause, or deactivate autonomous behavior. "
        "Only available when autonomy is currently running."
    ),
    similes=["STOP_AUTONOMY", "PAUSE_AUTONOMY", "DEACTIVATE_AUTONOMY"],
    examples=[
        [
            {
                "name": "User",
                "content": {"text": "Disable autonomy"},
            },
            {
                "name": "Agent",
                "content": {
                    "text": "Autonomy has been disabled.",
                    "action": "DISABLE_AUTONOMY",
                },
            },
        ],
        [
            {
                "name": "User",
                "content": {"text": "Stop being autonomous"},
            },
            {
                "name": "Agent",
                "content": {
                    "text": "Autonomy has been disabled.",
                    "action": "DISABLE_AUTONOMY",
                },
            },
        ],
    ],
    validate=_validate_disable_autonomy,
    handler=_handle_disable_autonomy,
)
