"""Onboarding Providers.

Provides onboarding status and context to the LLM during secret collection.
Injects prompts about required settings into the agent's context.

Ported from secrets/onboarding/provider.ts.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from elizaos.types import Provider

from .config import OnboardingSetting

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _format_setting_value(setting: OnboardingSetting, is_onboarding: bool) -> str:
    if setting.value is None:
        return "Not set"
    if setting.secret and not is_onboarding:
        return "****************"
    return str(setting.value)


def _generate_status_message(
    settings: dict[str, OnboardingSetting],
    is_onboarding: bool,
    agent_name: str,
    sender_name: str | None = None,
) -> str:
    entries = list(settings.items())

    formatted: list[dict[str, Any]] = []
    for key, setting in entries:
        if setting.visible_if and not setting.visible_if(settings):
            continue
        formatted.append(
            {
                "key": key,
                "name": setting.name,
                "value": _format_setting_value(setting, is_onboarding),
                "description": setting.description,
                "usage_description": setting.usage_description or setting.description,
                "required": setting.required,
                "configured": setting.value is not None,
            }
        )

    required_unconfigured = sum(1 for s in formatted if s["required"] and not s["configured"])

    if is_onboarding:
        settings_list = "\n\n".join(
            f"{s['key']}: {s['value']} {'(Required)' if s['required'] else '(Optional)'}\n"
            f"({s['name']}) {s['usage_description']}"
            for s in formatted
        )
        valid_keys = "Valid setting keys: " + ", ".join(k for k, _ in entries)
        instructions = (
            f"Instructions for {agent_name}:\n"
            "- Only update settings if the user is clearly responding to a setting you are currently asking about.\n"
            "- If the user's reply clearly maps to a setting and a valid value, you **must** call the UPDATE_SETTINGS action with the correct key and value.\n"
            "- Never hallucinate settings or respond with values not listed above.\n"
            "- Do not call UPDATE_SETTINGS just because onboarding started. Only update when the user provides a specific value.\n"
            "- Answer setting-related questions using only the name, description, and value from the list."
        )

        if required_unconfigured > 0:
            name = sender_name or "user"
            return (
                f"# PRIORITY TASK: Onboarding with {name}\n\n"
                f"{agent_name} needs to help the user configure {required_unconfigured} required settings:\n\n"
                f"{settings_list}\n\n"
                f"{valid_keys}\n\n"
                f"{instructions}\n\n"
                "- Prioritize configuring required settings before optional ones."
            )

        return (
            "All required settings have been configured. Here's the current configuration:\n\n"
            f"{settings_list}\n\n"
            f"{valid_keys}\n\n"
            f"{instructions}"
        )

    # Non-onboarding context
    important = ""
    if required_unconfigured > 0:
        important = (
            f"IMPORTANT!: {required_unconfigured} required settings still need configuration. "
            f"{agent_name} should get onboarded with the OWNER as soon as possible.\n\n"
        )
    else:
        important = "All required settings are configured.\n\n"

    detail = "\n\n".join(
        f"### {s['name']}\n**Value:** {s['value']}\n**Description:** {s['description']}"
        for s in formatted
    )

    return f"## Current Configuration\n\n{important}{detail}"


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


async def _onboarding_settings_get(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> dict[str, Any]:
    room = await runtime.get_room(message.room_id)
    if not room:
        logger.debug("[OnboardingSettingsProvider] No room found")
        return {
            "data": {"settings": []},
            "values": {"settings": "Error: Room not found"},
            "text": "Error: Room not found",
        }

    world_id = getattr(room, "world_id", None)
    if not world_id:
        logger.debug("[OnboardingSettingsProvider] No world ID for room")
        return {
            "data": {"settings": []},
            "values": {"settings": "Room has no associated world."},
            "text": "Room has no associated world.",
        }

    room_type = getattr(room, "type", None)
    is_onboarding = room_type == "DM" or room_type == "dm"

    world = await runtime.get_world(world_id)
    if not world:
        logger.debug("[OnboardingSettingsProvider] No world found")
        return {
            "data": {"settings": []},
            "values": {"settings": "Error: World not found"},
            "text": "Error: World not found",
        }

    world_settings = (getattr(world, "metadata", None) or {}).get("settings")
    if not world_settings:
        if is_onboarding:
            return {
                "data": {"settings": []},
                "values": {
                    "settings": "No settings configured for this world. Use initializeOnboarding to set up."
                },
                "text": "No settings configured for this world.",
            }
        return {"data": {"settings": []}, "values": {"settings": ""}, "text": ""}

    agent_name = getattr(runtime.character, "name", "Agent") if runtime.character else "Agent"
    sender_name = getattr(state, "sender_name", None) if state else None

    output = _generate_status_message(world_settings, is_onboarding, agent_name, sender_name)

    return {
        "data": {"settings": world_settings},
        "values": {"settings": output},
        "text": output,
    }


async def _missing_secrets_get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> dict[str, Any]:
    room = await runtime.get_room(message.room_id)
    if not room or not getattr(room, "world_id", None):
        return {"data": {"missing": []}, "values": {"missingSecrets": ""}, "text": ""}

    world = await runtime.get_world(room.world_id)
    if not world or not getattr(world, "metadata", None):
        return {"data": {"missing": []}, "values": {"missingSecrets": ""}, "text": ""}

    metadata: dict[str, Any] = world.metadata if isinstance(world.metadata, dict) else {}
    raw_settings = metadata.get("settings")
    if not isinstance(raw_settings, dict):
        return {"data": {"missing": []}, "values": {"missingSecrets": ""}, "text": ""}

    settings: dict[str, OnboardingSetting] = {
        key: value
        for key, value in raw_settings.items()
        if isinstance(key, str) and isinstance(value, OnboardingSetting)
    }
    if not settings:
        return {"data": {"missing": []}, "values": {"missingSecrets": ""}, "text": ""}

    entries = list(settings.items())

    missing_required = [
        {"key": k, "name": s.name, "description": s.usage_description or s.description}
        for k, s in entries
        if isinstance(s, OnboardingSetting) and s.required and s.value is None
    ]
    missing_optional = [
        {"key": k, "name": s.name, "description": s.usage_description or s.description}
        for k, s in entries
        if isinstance(s, OnboardingSetting) and not s.required and s.value is None
    ]

    if not missing_required and not missing_optional:
        return {
            "data": {"missing": []},
            "values": {"missingSecrets": "All secrets are configured."},
            "text": "All secrets are configured.",
        }

    parts: list[str] = []
    if missing_required:
        lines = "\n".join(f"- {s['key']}: {s['description']}" for s in missing_required)
        parts.append(f"Missing required secrets:\n{lines}")
    if missing_optional:
        lines = "\n".join(f"- {s['key']}: {s['description']}" for s in missing_optional)
        parts.append(f"Missing optional secrets:\n{lines}")

    output = "\n\n".join(parts)

    return {
        "data": {
            "missing": missing_required + missing_optional,
            "missingRequired": missing_required,
            "missingOptional": missing_optional,
        },
        "values": {"missingSecrets": output},
        "text": output,
    }


onboarding_settings_provider = Provider(
    name="ONBOARDING_SETTINGS",
    description="Current onboarding settings status for secrets collection",
    dynamic=True,
    get=_onboarding_settings_get,
)

missing_secrets_provider = Provider(
    name="MISSING_SECRETS",
    description="Lists secrets that still need to be configured",
    dynamic=True,
    get=_missing_secrets_get,
)
