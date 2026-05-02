"""Update Settings Action.

Extracts and saves setting values from natural language user messages
during the onboarding process.  Uses the LLM to parse user responses
and map them to settings.

Ported from secrets/onboarding/action.ts.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionResult, Content, ModelType

from ..types import SecretContext, SecretLevel
from .config import OnboardingSetting

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import SecretsService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _extract_setting_values(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    settings: dict[str, OnboardingSetting],
) -> list[dict[str, Any]]:
    """Extract setting values from user message using LLM."""
    unconfigured = [(key, s) for key, s in settings.items() if s.value is None]
    if not unconfigured:
        return []

    settings_context = "\n".join(
        f"{key}: {s.description} {'Required.' if s.required else 'Optional.'}"
        for key, s in unconfigured
    )
    text = ""
    if state and hasattr(state, "text"):
        text = getattr(state, "text", "")
    if not text and message.content:
        text = message.content.text or ""

    prompt = (
        "I need to extract settings values from the user's message.\n\n"
        f"Available settings:\n{settings_context}\n\n"
        f"User message: {text}\n\n"
        "For each setting mentioned in the user's message, extract the value.\n\n"
        "Only return settings that are clearly mentioned in the user's message.\n"
        "If a setting is mentioned but no clear value is provided, do not include it."
    )

    result = await runtime.use_model(ModelType.OBJECT_LARGE, prompt=prompt)

    if not result:
        return []

    valid_updates: list[dict[str, Any]] = []

    def _extract(obj: Any) -> None:
        if isinstance(obj, list):
            for item in obj:
                _extract(item)
        elif isinstance(obj, dict):
            for key, value in obj.items():
                if key in settings and not isinstance(value, (dict, list)):
                    valid_updates.append({"key": key, "value": value})
                else:
                    _extract(value)

    _extract(result)
    return valid_updates


async def _process_setting_updates(
    runtime: IAgentRuntime,
    world: Any,
    settings: dict[str, OnboardingSetting],
    updates: list[dict[str, Any]],
    secrets_service: SecretsService | None,
) -> dict[str, Any]:
    """Process setting updates and save to storage."""
    if not updates:
        return {"updated_any": False, "messages": []}

    messages: list[str] = []
    updated_any = False
    updated_settings = dict(settings)

    for update in updates:
        key = update["key"]
        setting = updated_settings.get(key)
        if not setting:
            continue

        # Check dependencies
        if setting.depends_on:
            deps_met = all(
                updated_settings.get(dep) is not None and updated_settings[dep].value is not None
                for dep in setting.depends_on
            )
            if not deps_met:
                messages.append(f"Cannot update {setting.name} - dependencies not met")
                continue

        # Validate
        value_str = str(update["value"])
        if setting.validation and not setting.validation(value_str):
            messages.append(f"Invalid value for {setting.name}")
            continue

        if setting.validation_method:
            from ..validation import validate_secret

            validation = await validate_secret(key, value_str, setting.validation_method)
            if not validation.is_valid:
                messages.append(f"Validation failed for {setting.name}: {validation.error}")
                continue

        # Update local state
        updated_settings[key] = OnboardingSetting(
            name=setting.name,
            description=setting.description,
            usage_description=setting.usage_description,
            secret=setting.secret,
            public=setting.public,
            required=setting.required,
            depends_on=list(setting.depends_on),
            validation=setting.validation,
            validation_method=setting.validation_method,
            type=setting.type,
            env_var=setting.env_var,
            value=value_str,
            visible_if=setting.visible_if,
            on_set_action=setting.on_set_action,
        )

        # Store in secrets service if available
        if secrets_service is not None:
            context = SecretContext(
                level=SecretLevel.WORLD,
                agent_id=str(runtime.agent_id),
                world_id=str(world.id) if hasattr(world, "id") else None,
            )
            await secrets_service.set(key, value_str, context)

        messages.append(f"Updated {setting.name} successfully")
        updated_any = True

        # Execute on_set_action if defined
        if setting.on_set_action:
            action_msg = setting.on_set_action(update["value"])
            if action_msg:
                messages.append(action_msg)

    # Save updated settings to world metadata
    if updated_any and hasattr(world, "metadata"):
        if world.metadata is None:
            world.metadata = {}
        world.metadata["settings"] = updated_settings
        await runtime.update_world(world)

    return {"updated_any": updated_any, "messages": messages}


def _get_next_required_setting(
    settings: dict[str, OnboardingSetting],
) -> tuple[str, OnboardingSetting] | None:
    """Get the next setting to configure."""
    for key, setting in settings.items():
        if not setting.required or setting.value is not None:
            continue
        deps_met = all(
            settings.get(dep) is not None and settings[dep].value is not None
            for dep in (setting.depends_on or [])
        )
        if deps_met:
            return (key, setting)
    return None


def _count_unconfigured_required(settings: dict[str, OnboardingSetting]) -> int:
    return sum(1 for s in settings.values() if s.required and s.value is None)


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text if message.content else "") or ""
    text_lower = text.lower()
    has_intent = "update" in text_lower and "settings" in text_lower
    if not has_intent:
        return False

    # Must be a DM channel
    channel_type = getattr(message.content, "channel_type", None) or getattr(
        message.content, "channelType", None
    )
    if channel_type != "DM" and channel_type != "dm":
        return False

    room = await runtime.get_room(message.room_id)
    if not room or not getattr(room, "world_id", None):
        return False

    world = await runtime.get_world(room.world_id)
    if not world or not getattr(world, "metadata", None):
        return False

    metadata: dict[str, Any] = world.metadata if isinstance(world.metadata, dict) else {}
    settings = metadata.get("settings")
    if not settings:
        return False

    return any(s.value is None for s in settings.values() if isinstance(s, OnboardingSetting))


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    if not callback:
        return ActionResult(
            text="Callback required",
            values={"success": False},
            data={"actionName": "UPDATE_SETTINGS"},
            success=False,
        )

    room = await runtime.get_room(message.room_id)
    if not room or not getattr(room, "world_id", None):
        await callback(Content(text="Unable to find room configuration."))
        return ActionResult(
            text="Room not found",
            values={"success": False},
            data={"actionName": "UPDATE_SETTINGS"},
            success=False,
        )

    world = await runtime.get_world(room.world_id)
    if not world or not getattr(world, "metadata", None):
        await callback(Content(text="No settings configured for this world."))
        return ActionResult(
            text="No settings found",
            values={"success": False},
            data={"actionName": "UPDATE_SETTINGS"},
            success=False,
        )

    metadata: dict[str, Any] = world.metadata if isinstance(world.metadata, dict) else {}
    raw_settings = metadata.get("settings")
    settings: dict[str, OnboardingSetting] = (
        {
            key: value
            for key, value in raw_settings.items()
            if isinstance(key, str) and isinstance(value, OnboardingSetting)
        }
        if isinstance(raw_settings, dict)
        else {}
    )
    if not settings:
        await callback(Content(text="No settings configured for this world."))
        return ActionResult(
            text="No settings found",
            values={"success": False},
            data={"actionName": "UPDATE_SETTINGS"},
            success=False,
        )

    # Get secrets service
    secrets_service: SecretsService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "secrets":
            secrets_service = svc  # type: ignore[assignment]
            break

    # Extract settings from message
    logger.info("[UpdateSettings] Extracting settings from message")
    extracted = await _extract_setting_values(runtime, message, state, settings)
    logger.info("[UpdateSettings] Extracted %d settings", len(extracted))

    # Process updates
    results = await _process_setting_updates(runtime, world, settings, extracted, secrets_service)

    # Get updated settings
    updated_world = await runtime.get_world(room.world_id)
    updated_settings: dict[str, OnboardingSetting] = settings
    if updated_world and getattr(updated_world, "metadata", None):
        updated_metadata: dict[str, Any] = (
            updated_world.metadata if isinstance(updated_world.metadata, dict) else {}
        )
        updated_raw_settings = updated_metadata.get("settings")
        if isinstance(updated_raw_settings, dict):
            updated_settings = {
                key: value
                for key, value in updated_raw_settings.items()
                if isinstance(key, str) and isinstance(value, OnboardingSetting)
            } or settings

    if results["updated_any"]:
        remaining = _count_unconfigured_required(updated_settings)

        if remaining == 0:
            await callback(
                Content(
                    text=f"{chr(10).join(results['messages'])}\n\nAll required settings have been configured! You're all set.",
                    actions=["ONBOARDING_COMPLETE"],
                )
            )
            return ActionResult(
                text="Onboarding complete",
                values={"success": True, "onboardingComplete": True},
                data={"actionName": "UPDATE_SETTINGS", "action": "ONBOARDING_COMPLETE"},
                success=True,
            )

        # More settings needed
        next_pair = _get_next_required_setting(updated_settings)
        next_prompt = ""
        if next_pair:
            next_key, next_setting = next_pair
            next_prompt = (
                f"\n\nNext, I need your {next_setting.name}. "
                f"{next_setting.usage_description or next_setting.description}"
            )

        await callback(
            Content(
                text=f"{chr(10).join(results['messages'])}{next_prompt}",
                actions=["SETTING_UPDATED"],
            )
        )
        return ActionResult(
            text="Settings updated",
            values={"success": True, "remainingRequired": remaining},
            data={
                "actionName": "UPDATE_SETTINGS",
                "action": "SETTING_UPDATED",
                "updated": [u["key"] for u in extracted],
            },
            success=True,
        )

    # No settings extracted
    next_pair = _get_next_required_setting(settings)
    if next_pair:
        next_key, next_setting = next_pair
        prompt_msg = (
            f"I couldn't understand that. I need your {next_setting.name}. "
            f"{next_setting.usage_description or next_setting.description}"
        )
    else:
        prompt_msg = "I couldn't extract any settings from your message. Could you try again?"

    await callback(Content(text=prompt_msg, actions=["SETTING_UPDATE_FAILED"]))
    return ActionResult(
        text="No settings updated",
        values={"success": False},
        data={"actionName": "UPDATE_SETTINGS", "action": "SETTING_UPDATE_FAILED"},
        success=False,
    )


update_settings_action = Action(
    name="UPDATE_SETTINGS",
    similes=["UPDATE_SETTING", "SAVE_SETTING", "SET_CONFIGURATION", "CONFIGURE"],
    description=(
        "Saves a configuration setting during the onboarding process. "
        "Use when onboarding with a world owner or admin."
    ),
    validate=_validate,
    handler=_handler,
    examples=[
        [
            {
                "name": "{{name1}}",
                "content": {"text": "My OpenAI key is sk-abc123def456", "source": "discord"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "Got it! I've saved your OpenAI API Key. Next, I need your Anthropic API Key.",
                    "actions": ["SETTING_UPDATED"],
                    "source": "discord",
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Here's my Twitter login: @myhandle with password secret123",
                    "source": "discord",
                },
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "Perfect! I've updated your Twitter Username and Twitter Password. We're all set!",
                    "actions": ["ONBOARDING_COMPLETE"],
                    "source": "discord",
                },
            },
        ],
    ],
)
