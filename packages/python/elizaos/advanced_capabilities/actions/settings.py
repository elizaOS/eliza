from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import UPDATE_SETTINGS_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType
from elizaos.utils.spec_examples import convert_spec_examples

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("UPDATE_SETTINGS")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class SettingUpdate:
    key: str
    value: str


@dataclass
class UpdateSettingsAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
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
        if state is None:
            raise ValueError("State is required for UPDATE_SETTINGS action")

        state = await runtime.compose_state(
            message, ["RECENT_MESSAGES", "ACTION_STATE", "AGENT_SETTINGS"]
        )

        current_settings = runtime.get_all_settings()
        settings_context = "\n".join(
            f"- {key}: {value}"
            for key, value in current_settings.items()
            if not key.lower().endswith(("key", "secret", "password", "token"))
        )

        template = (
            runtime.character.templates.get("updateSettingsTemplate")
            if runtime.character.templates
            and "updateSettingsTemplate" in runtime.character.templates
            else UPDATE_SETTINGS_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)
        prompt = prompt.replace("{{settings}}", settings_context)

        response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response_text)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response")

        thought = str(parsed_xml.get("thought", ""))
        updates_raw = parsed_xml.get("updates", [])

        updated_settings: list[SettingUpdate] = []

        if isinstance(updates_raw, list):
            for update in updates_raw:
                if isinstance(update, dict):
                    key = str(update.get("key", ""))
                    value = str(update.get("value", ""))
                    if key and value:
                        updated_settings.append(SettingUpdate(key=key, value=value))
        elif isinstance(updates_raw, dict):
            update_list = updates_raw.get("update", [])
            if isinstance(update_list, dict):
                update_list = [update_list]
            for update in update_list:
                if isinstance(update, dict):
                    key = str(update.get("key", ""))
                    value = str(update.get("value", ""))
                    if key and value:
                        updated_settings.append(SettingUpdate(key=key, value=value))

        if not updated_settings:
            return ActionResult(
                text="No settings to update",
                values={"success": True, "noChanges": True},
                data={"actionName": "UPDATE_SETTINGS", "thought": thought},
                success=True,
            )

        for setting in updated_settings:
            runtime.set_setting(setting.key, setting.value)

        updated_keys = [s.key for s in updated_settings]

        response_content = Content(
            text=f"Updated {len(updated_settings)} setting(s): {', '.join(updated_keys)}",
            actions=["UPDATE_SETTINGS"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Updated settings: {', '.join(updated_keys)}",
            values={
                "success": True,
                "settingsUpdated": True,
                "updatedCount": len(updated_settings),
                "updatedKeys": ", ".join(updated_keys),
            },
            data={
                "actionName": "UPDATE_SETTINGS",
                "updatedSettings": updated_keys,
                "thought": thought,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


update_settings_action = Action(
    name=UpdateSettingsAction.name,
    similes=UpdateSettingsAction().similes,
    description=UpdateSettingsAction.description,
    validate=UpdateSettingsAction().validate,
    handler=UpdateSettingsAction().handler,
    examples=UpdateSettingsAction().examples,
)
