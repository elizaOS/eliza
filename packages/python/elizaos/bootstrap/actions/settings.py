"""
UPDATE_SETTINGS Action - Update agent or world settings.

This action allows the agent to modify configuration settings
for itself or the world context.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.prompts import UPDATE_SETTINGS_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class SettingUpdate:
    """Represents a single setting update."""

    key: str
    value: str


@dataclass
class UpdateSettingsAction:
    """
    Action for updating settings.

    This action is used when:
    - Configuration changes are needed
    - Agent behavior should be modified
    - World settings need adjustment
    """

    name: str = "UPDATE_SETTINGS"
    similes: list[str] = field(
        default_factory=lambda: [
            "CHANGE_SETTINGS",
            "MODIFY_SETTINGS",
            "CONFIGURE",
            "SET_PREFERENCE",
            "UPDATE_CONFIG",
        ]
    )
    description: str = (
        "Update configuration settings for the agent or world. "
        "Use this to modify behavior and preferences."
    )

    async def validate(self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None) -> bool:
        """Validate that settings can be updated."""
        # Settings can always be updated if the agent is running
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
        """Handle settings update."""
        if state is None:
            raise ValueError("State is required for UPDATE_SETTINGS action")

        try:
            # Compose state with context
            state = await runtime.compose_state(
                message, ["RECENT_MESSAGES", "ACTION_STATE", "AGENT_SETTINGS"]
            )

            # Get current settings for context
            current_settings = runtime.get_all_settings()
            settings_context = "\n".join(
                f"- {key}: {value}"
                for key, value in current_settings.items()
                if not key.lower().endswith(("key", "secret", "password", "token"))
            )

            template = (
                runtime.character.templates.get("updateSettingsTemplate")
                if runtime.character.templates and "updateSettingsTemplate" in runtime.character.templates
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

            # Parse updates
            updated_settings: list[SettingUpdate] = []

            if isinstance(updates_raw, list):
                for update in updates_raw:
                    if isinstance(update, dict):
                        key = str(update.get("key", ""))
                        value = str(update.get("value", ""))
                        if key and value:
                            updated_settings.append(SettingUpdate(key=key, value=value))
            elif isinstance(updates_raw, dict):
                # Handle nested structure
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

            # Apply updates
            for setting in updated_settings:
                runtime.set_setting(setting.key, setting.value)

            # Return updated setting keys (not full objects for ProviderValue compatibility)
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

        except Exception as error:
            runtime.logger.error(
                {
                    "src": "plugin:bootstrap:action:settings",
                    "agentId": runtime.agent_id,
                    "error": str(error),
                },
                "Error updating settings",
            )
            return ActionResult(
                text="Error updating settings",
                values={"success": False, "error": str(error)},
                data={"actionName": "UPDATE_SETTINGS", "error": str(error)},
                success=False,
                error=error,
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the UPDATE_SETTINGS action."""
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Change the response language to Spanish."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll update the language setting.",
                        actions=["UPDATE_SETTINGS"],
                    ),
                ),
            ],
        ]


# Create the action instance
update_settings_action = Action(
    name=UpdateSettingsAction.name,
    similes=UpdateSettingsAction().similes,
    description=UpdateSettingsAction.description,
    validate=UpdateSettingsAction().validate,
    handler=UpdateSettingsAction().handler,
    examples=UpdateSettingsAction().examples,
)

