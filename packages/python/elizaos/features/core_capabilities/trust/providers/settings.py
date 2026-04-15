"""Settings provider.

Provides current configuration/settings status for the server, used
during onboarding and normal operation. Ported from the TypeScript
``settingsProvider``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def _is_setting_entry(value: Any) -> bool:
    """Check if *value* looks like a Setting dict."""
    return isinstance(value, dict) and "name" in value and "value" in value


def _format_setting_value(setting: dict[str, Any], is_onboarding: bool) -> str:
    """Return display string for a setting value."""
    val = setting.get("value")
    if val is None:
        return "Not set"
    if setting.get("secret") and not is_onboarding:
        return "****************"
    return str(val)


def _generate_status_message(
    world_settings: dict[str, Any],
    is_onboarding: bool,
    agent_name: str = "Agent",
) -> str:
    """Generate a human-readable settings status message."""
    formatted: list[dict[str, Any]] = []
    for key, setting in world_settings.items():
        if key.startswith("_") or not _is_setting_entry(setting):
            continue
        formatted.append(
            {
                "key": key,
                "name": setting.get("name", key),
                "value": _format_setting_value(setting, is_onboarding),
                "description": setting.get("description", ""),
                "usage_description": setting.get("usageDescription", ""),
                "required": setting.get("required", False),
                "configured": setting.get("value") is not None,
            }
        )

    required_unconfigured = sum(1 for s in formatted if s["required"] and not s["configured"])

    if is_onboarding:
        settings_list = "\n\n".join(
            f"{s['key']}: {s['value']} "
            f"({'Required' if s['required'] else 'Optional'})\n"
            f"({s['name']}) {s['usage_description']}"
            for s in formatted
        )
        valid_keys = f"Valid setting keys: {', '.join(s['key'] for s in formatted)}"

        if required_unconfigured > 0:
            return (
                f"# PRIORITY TASK: Onboarding\n\n"
                f"{agent_name} needs to help the user configure "
                f"{required_unconfigured} required settings:\n\n"
                f"{settings_list}\n\n{valid_keys}"
            )
        return (
            f"All required settings have been configured. "
            f"Here's the current configuration:\n\n"
            f"{settings_list}\n\n{valid_keys}"
        )

    # Non-onboarding: summary view
    header = ""
    if required_unconfigured > 0:
        header = (
            f"IMPORTANT: {required_unconfigured} required settings still need configuration.\n\n"
        )
    else:
        header = "All required settings are configured.\n\n"

    details = "\n\n".join(
        f"### {s['name']}\n**Value:** {s['value']}\n**Description:** {s['description']}"
        for s in formatted
    )
    return f"## Current Configuration\n\n{header}{details}"


async def get_settings(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide current settings for the server/world."""
    # Retrieve room
    get_room = getattr(runtime, "get_room", None)
    room = await get_room(message.room_id) if callable(get_room) else None

    if room is None:
        return ProviderResult(
            text="No room context available for settings.",
            values={"settings": "No room context available for settings."},
            data={"settings": []},
        )

    world_id = getattr(room, "world_id", None) or getattr(room, "worldId", None)
    if not world_id:
        return ProviderResult(
            text="Room does not have a worldId -- settings provider will be skipped",
            values={
                "settings": "Room does not have a worldId -- settings provider will be skipped",
            },
            data={"settings": []},
        )

    room_type = getattr(room, "type", None) or getattr(room, "channel_type", None)
    is_onboarding = str(room_type).upper() == "DM" if room_type else False

    # Retrieve world
    get_world = getattr(runtime, "get_world", None)
    world = await get_world(world_id) if callable(get_world) else None

    if world is None:
        return ProviderResult(
            text="No settings available -- world not found.",
            values={"settings": "No settings available -- world not found."},
            data={"settings": []},
        )

    metadata: dict[str, Any] = getattr(world, "metadata", None) or {}
    world_settings = metadata.get("settings")

    if not world_settings or not isinstance(world_settings, dict):
        msg = (
            "The user doesn't appear to have any settings configured for this server."
            if is_onboarding
            else "Configuration has not been completed yet."
        )
        return ProviderResult(
            text=msg,
            values={"settings": msg},
            data={"settings": []},
        )

    # Retrieve agent name for status message
    character = getattr(runtime, "character", None)
    agent_name = getattr(character, "name", "Agent") if character else "Agent"

    output = _generate_status_message(world_settings, is_onboarding, agent_name)

    return ProviderResult(
        text=output,
        values={"settings": output},
        data={"settings": world_settings},
    )


settings_provider = Provider(
    name="SETTINGS",
    description="Current settings for the server",
    get=get_settings,
    dynamic=True,
)
