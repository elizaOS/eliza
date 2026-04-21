"""Update settings action.

Saves or updates a configuration setting during the onboarding process
or for an existing world/server. Ported from the TypeScript
``updateSettingsAction``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, TypeGuard

from elizaos.types import Action, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


# ---------------------------------------------------------------------------
# Helper types and utilities
# ---------------------------------------------------------------------------


def _is_setting_entry(value: Any) -> TypeGuard[dict[str, Any]]:
    """Check if *value* looks like a Setting dict with 'name' and 'value' keys."""
    return isinstance(value, dict) and "name" in value and "value" in value


def _format_setting_value(setting: dict[str, Any], is_onboarding: bool) -> str:
    """Return a display string for a setting value."""
    val = setting.get("value")
    if val is None:
        return "Not set"
    if setting.get("secret") and not is_onboarding:
        return "****************"
    return str(val)


def _categorize_settings(
    world_settings: dict[str, Any],
) -> tuple[
    list[tuple[str, dict[str, Any]]],
    list[tuple[str, dict[str, Any]]],
    list[tuple[str, dict[str, Any]]],
]:
    """Categorize settings into configured, required-unconfigured, and optional-unconfigured."""
    configured: list[tuple[str, dict[str, Any]]] = []
    required_unconfigured: list[tuple[str, dict[str, Any]]] = []
    optional_unconfigured: list[tuple[str, dict[str, Any]]] = []

    for key, setting in world_settings.items():
        if key.startswith("_") or not _is_setting_entry(setting):
            continue
        if setting.get("value") is not None:
            configured.append((key, setting))
        elif setting.get("required"):
            required_unconfigured.append((key, setting))
        else:
            optional_unconfigured.append((key, setting))

    return configured, required_unconfigured, optional_unconfigured


def _format_settings_list(world_settings: dict[str, Any]) -> str:
    """Format settings into a readable list."""
    lines: list[str] = []
    for key, setting in world_settings.items():
        if key.startswith("_") or not _is_setting_entry(setting):
            continue
        status = "Configured" if setting.get("value") is not None else "Not configured"
        required = "Required" if setting.get("required") else "Optional"
        lines.append(f"- {setting['name']} ({key}): {status}, {required}")
    return "\n".join(lines) if lines else "No settings available"


def _extract_setting_values(text: str, world_settings: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract setting key/value pairs from user text.

    Uses simple heuristics: looks for known setting keys in the text and
    tries to extract values.  In a full implementation this would use an
    LLM model call.
    """
    results: list[dict[str, Any]] = []
    text_lower = text.lower()

    _, required_unconfigured, optional_unconfigured = _categorize_settings(world_settings)
    all_unconfigured = required_unconfigured + optional_unconfigured

    for key, setting in all_unconfigured:
        key_lower = key.lower()
        name_lower = setting.get("name", "").lower()

        # Check if the key or setting name appears in the message
        if key_lower in text_lower or name_lower in text_lower:
            # Try to extract a value after the key mention
            value = _extract_value_for_key(text, key, setting)
            if value is not None:
                results.append({"key": key, "value": value})

    return results


def _extract_value_for_key(text: str, key: str, setting: dict[str, Any]) -> str | None:
    """Try to extract a value for a specific setting key from text."""
    import re

    # Pattern: "key to <value>" or "key = <value>" or "key: <value>"
    patterns = [
        rf"(?i){re.escape(key)}\s*(?:to|=|:)\s*(.+?)(?:\.|,|$)",
        rf"(?i)set\s+{re.escape(key)}\s+(?:to\s+)?(.+?)(?:\.|,|$)",
    ]
    name = setting.get("name", "")
    if name:
        patterns.append(rf"(?i){re.escape(name)}\s*(?:to|=|:)\s*(.+?)(?:\.|,|$)")

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip()

    return None


async def _get_world_settings(runtime: IAgentRuntime, server_id: str) -> dict[str, Any] | None:
    """Retrieve world settings from the runtime."""
    get_world = getattr(runtime, "get_world", None)
    if not callable(get_world):
        return None

    # Build world ID from server_id
    create_uuid = getattr(runtime, "create_unique_uuid", None)
    world_id = create_uuid(server_id) if callable(create_uuid) else server_id

    world = await get_world(world_id)
    if world is None:
        return None

    metadata: dict[str, Any] = getattr(world, "metadata", None) or {}
    settings = metadata.get("settings")
    if settings and isinstance(settings, dict):
        return settings
    return None


async def _update_world_settings(
    runtime: IAgentRuntime, server_id: str, world_settings: dict[str, Any]
) -> bool:
    """Persist updated world settings."""
    get_world = getattr(runtime, "get_world", None)
    update_world = getattr(runtime, "update_world", None)
    if not callable(get_world) or not callable(update_world):
        return False

    create_uuid = getattr(runtime, "create_unique_uuid", None)
    world_id = create_uuid(server_id) if callable(create_uuid) else server_id

    world = await get_world(world_id)
    if world is None:
        return False

    metadata: dict[str, Any] = getattr(world, "metadata", None) or {}
    metadata["settings"] = world_settings
    world.metadata = metadata  # type: ignore[attr-defined]
    await update_world(world)
    return True


# ---------------------------------------------------------------------------
# Action dataclass
# ---------------------------------------------------------------------------


@dataclass
class UpdateSettingsAction:
    """Save/update configuration settings during onboarding or operation."""

    name: str = "UPDATE_SETTINGS"
    similes: list[str] = field(
        default_factory=lambda: [
            "UPDATE_SETTING",
            "SAVE_SETTING",
            "SET_CONFIGURATION",
            "CONFIGURE",
        ]
    )
    description: str = (
        "Saves a configuration setting during the onboarding process, "
        "or updates an existing setting. Use this when onboarding with "
        "a world owner or admin."
    )

    async def validate(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | None = None,
    ) -> bool:
        """Validate that the message mentions settings/configuration keywords."""
        text = (message.content.text if message.content else "").lower()
        keywords = {
            "setting",
            "settings",
            "configure",
            "configuration",
            "set up",
            "setup",
            "update",
            "prefix",
            "channel",
            "enable",
            "disable",
        }
        return any(kw in text for kw in keywords)

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        entity_id = message.entity_id
        if entity_id is None:
            return ActionResult(
                text="Cannot update settings: no entity specified.",
                success=False,
            )

        # Determine server ID from message content
        server_id: str | None = getattr(message.content, "server_id", None) or getattr(
            message.content, "serverId", None
        )

        if server_id is None:
            # Try world_id setting
            get_setting = getattr(runtime, "get_setting", None)
            if callable(get_setting):
                server_id = get_setting("WORLD_ID") or get_setting("SERVER_ID")

        if not server_id:
            msg = "No server context found. Settings can only be updated within a server."
            if callback:
                await callback(Content(text=msg, actions=["UPDATE_SETTINGS"]))
            return ActionResult(text=msg, success=False)

        # Retrieve current world settings
        world_settings = await _get_world_settings(runtime, server_id)
        if world_settings is None:
            msg = "No settings configuration found for this server."
            if callback:
                await callback(Content(text=msg, actions=["UPDATE_SETTINGS"]))
            return ActionResult(
                text=msg,
                values={"error": "NO_SETTINGS_STATE"},
                success=False,
            )

        # Extract setting updates from the message
        text = message.content.text if message.content else ""
        extracted = _extract_setting_values(text, world_settings)

        if not extracted:
            _, required_unconfigured, _ = _categorize_settings(world_settings)
            if required_unconfigured:
                next_key, next_setting = required_unconfigured[0]
                hint = (
                    f"I couldn't identify a setting to update from your message. "
                    f"The next required setting is **{next_setting.get('name', next_key)}**: "
                    f"{next_setting.get('description', 'No description')}. "
                    f"Please provide a value for it."
                )
            else:
                hint = (
                    "I couldn't identify any setting to update from your message. "
                    "Please specify which setting you'd like to change and its new value."
                )
            if callback:
                await callback(Content(text=hint, actions=["SETTING_UPDATE_FAILED"]))
            return ActionResult(
                text="No settings were updated from your message.",
                values={"success": False, "reason": "NO_VALID_SETTINGS_FOUND"},
                success=False,
            )

        # Apply updates
        messages: list[str] = []
        updated_any = False
        updated_settings = {**world_settings}

        for update in extracted:
            key = update["key"]
            value = update["value"]
            setting = updated_settings.get(key)
            if not _is_setting_entry(setting):
                continue

            # Check dependencies
            depends_on = setting.get("dependsOn") or []
            if depends_on:
                deps_met = True
                for dep in depends_on:
                    dep_setting = updated_settings.get(dep)
                    if not _is_setting_entry(dep_setting) or dep_setting.get("value") is None:
                        deps_met = False
                        break
                if not deps_met:
                    messages.append(f"Cannot update {setting['name']} -- dependencies not met")
                    continue

            updated_settings[key] = {**setting, "value": value}
            messages.append(f"Updated {setting['name']} successfully")
            updated_any = True

        if updated_any:
            saved = await _update_world_settings(runtime, server_id, updated_settings)
            if not saved:
                msg = "Failed to save updated settings."
                if callback:
                    await callback(Content(text=msg, actions=["SETTING_UPDATE_ERROR"]))
                return ActionResult(text=msg, success=False)

        # Generate response
        if updated_any:
            _, remaining_required, _ = _categorize_settings(updated_settings)
            if not remaining_required:
                response_text = (
                    "All required settings have been configured. "
                    "Your server is now fully set up and ready to use."
                )
                action_tag = "ONBOARDING_COMPLETE"
            else:
                next_key, next_setting = remaining_required[0]
                response_text = (
                    f"{'. '.join(messages)}. "
                    f"Next, please configure **{next_setting.get('name', next_key)}**: "
                    f"{next_setting.get('description', '')}. "
                    f"{len(remaining_required)} required setting(s) remaining."
                )
                action_tag = "SETTING_UPDATED"

            if callback:
                await callback(Content(text=response_text, actions=[action_tag]))

            return ActionResult(
                text=". ".join(messages),
                values={
                    "success": True,
                    "updatedSettings": extracted,
                    "messages": messages,
                },
                data={
                    "actionName": "UPDATE_SETTINGS",
                    "success": True,
                },
                success=True,
            )
        else:
            joined = ". ".join(messages) if messages else "No settings were updated."
            if callback:
                await callback(Content(text=joined, actions=["SETTING_UPDATE_FAILED"]))
            return ActionResult(
                text=joined,
                values={"success": False},
                success=False,
            )

    @property
    def examples(self) -> list:
        return []


_inst = UpdateSettingsAction()

update_settings_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
