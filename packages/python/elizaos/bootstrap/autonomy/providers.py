from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from elizaos.types.components import Provider, ProviderResult
from elizaos.types.primitives import as_uuid

from .service import AUTONOMY_SERVICE_TYPE, AutonomyService

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


async def _get_admin_chat_history(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> ProviderResult:
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        return ProviderResult(text="")

    autonomous_room_id = autonomy_service.get_autonomous_room_id()
    if not autonomous_room_id or message.room_id != autonomous_room_id:
        return ProviderResult(text="")

    admin_user_id = runtime.get_setting("ADMIN_USER_ID")
    if not admin_user_id:
        return ProviderResult(
            text="[ADMIN_CHAT_HISTORY]\nNo admin user configured. Set ADMIN_USER_ID in character settings.\n[/ADMIN_CHAT_HISTORY]",
            data={"adminConfigured": False},
        )

    admin_uuid = as_uuid(str(admin_user_id))

    admin_messages = await runtime.get_memories(
        {
            "entityId": admin_uuid,
            "count": 15,
            "unique": False,
            "tableName": "memories",
        }
    )

    if not admin_messages:
        return ProviderResult(
            text="[ADMIN_CHAT_HISTORY]\nNo recent messages found with admin user.\n[/ADMIN_CHAT_HISTORY]",
            data={
                "adminConfigured": True,
                "messageCount": 0,
                "adminUserId": str(admin_user_id),
            },
        )

    sorted_messages = sorted(admin_messages, key=lambda m: m.created_at or 0)[-10:]

    history_lines = []
    for msg in sorted_messages:
        is_from_admin = msg.entity_id == admin_uuid
        is_from_agent = msg.entity_id == runtime.agent_id

        sender = "Admin" if is_from_admin else "Agent" if is_from_agent else "Other"
        text = msg.content.text if msg.content and msg.content.text else "[No text content]"
        timestamp = datetime.fromtimestamp((msg.created_at or 0) / 1000).strftime("%H:%M:%S")

        history_lines.append(f"{timestamp} {sender}: {text}")

    conversation_history = "\n".join(history_lines)

    recent_admin_messages = [msg for msg in sorted_messages if msg.entity_id == admin_uuid][-3:]

    last_admin_message = recent_admin_messages[-1] if recent_admin_messages else None
    admin_mood_context = (
        f'Last admin message: "{last_admin_message.content.text if last_admin_message and last_admin_message.content else "N/A"}"'
        if recent_admin_messages
        else "No recent admin messages"
    )

    return ProviderResult(
        text=f"[ADMIN_CHAT_HISTORY]\nRecent conversation with admin user ({len(admin_messages)} total messages):\n\n{conversation_history}\n\n{admin_mood_context}\n[/ADMIN_CHAT_HISTORY]",
        data={
            "adminConfigured": True,
            "messageCount": len(admin_messages),
            "adminUserId": str(admin_user_id),
            "recentMessageCount": len(recent_admin_messages),
            "lastAdminMessage": last_admin_message.content.text
            if last_admin_message and last_admin_message.content
            else "",
            "conversationActive": any(
                (datetime.now().timestamp() * 1000) - (m.created_at or 0) < 3600000
                for m in admin_messages
            ),
        },
    )


async def _get_autonomy_status(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> ProviderResult:
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        return ProviderResult(text="")

    autonomous_room_id = autonomy_service.get_autonomous_room_id()
    if autonomous_room_id and message.room_id == autonomous_room_id:
        return ProviderResult(text="")

    setting_value = runtime.get_setting("AUTONOMY_ENABLED")
    autonomy_enabled = (
        setting_value is True
        or (isinstance(setting_value, str) and setting_value.strip().lower() == "true")
        or runtime.enable_autonomy is True
    )
    service_running = autonomy_service.is_loop_running()
    interval = autonomy_service.get_loop_interval()

    if service_running:
        status = "running autonomously"
        status_icon = "🤖"
    elif autonomy_enabled:
        status = "autonomy enabled but not running"
        status_icon = "⏸️"
    else:
        status = "autonomy disabled"
        status_icon = "🔕"

    interval_seconds = interval // 1000
    interval_unit = (
        f"{interval_seconds} seconds"
        if interval_seconds < 60
        else f"{interval_seconds // 60} minutes"
    )

    return ProviderResult(
        text=f"[AUTONOMY_STATUS]\nCurrent status: {status_icon} {status}\nThinking interval: {interval_unit}\n[/AUTONOMY_STATUS]",
        data={
            "autonomyEnabled": bool(autonomy_enabled),
            "serviceRunning": service_running,
            "interval": interval,
            "intervalSeconds": interval_seconds,
            "status": "running"
            if service_running
            else "enabled"
            if autonomy_enabled
            else "disabled",
        },
    )


admin_chat_provider = Provider(
    name="ADMIN_CHAT_HISTORY",
    description="Provides recent conversation history with the admin user for autonomous context",
    get=_get_admin_chat_history,
)

autonomy_status_provider = Provider(
    name="AUTONOMY_STATUS",
    description="Provides current autonomy status for agent awareness in conversations",
    get=_get_autonomy_status,
)
