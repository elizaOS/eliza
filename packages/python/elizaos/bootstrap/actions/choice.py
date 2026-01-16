from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import CHOOSE_OPTION_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("CHOOSE_OPTION")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
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


@dataclass
class ChooseOptionAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        if message.content and message.content.options:
            return len(message.content.options) > 0
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
            raise ValueError("State is required for CHOOSE_OPTION action")

        available_options: list[dict[str, str]] = []
        if message.content and message.content.options:
            available_options = message.content.options

        if not available_options:
            return ActionResult(
                text="No options available to choose from",
                values={"success": False, "error": "no_options"},
                data={"actionName": "CHOOSE_OPTION"},
                success=False,
            )

        state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ACTION_STATE"])

        options_context = "\n".join(
            f"- [{opt.get('id', idx)}] {opt.get('label', '')}: {opt.get('description', '')}"
            for idx, opt in enumerate(available_options)
        )

        template = (
            runtime.character.templates.get("chooseOptionTemplate")
            if runtime.character.templates and "chooseOptionTemplate" in runtime.character.templates
            else CHOOSE_OPTION_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)
        prompt = prompt.replace("{{options}}", options_context)

        response_text = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response_text)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response")

        thought = str(parsed_xml.get("thought", ""))
        selected_id = str(parsed_xml.get("selected_id", ""))

        if not selected_id:
            raise ValueError("No option selected")

        selected_option = next(
            (opt for opt in available_options if str(opt.get("id", "")) == selected_id),
            None,
        )

        if selected_option is None:
            raise ValueError(f"Selected option ID '{selected_id}' not found")

        response_content = Content(
            thought=thought,
            text=f"Selected option: {selected_option.get('label', selected_id)}",
            actions=["CHOOSE_OPTION"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Selected option: {selected_option.get('label', selected_id)}",
            values={
                "success": True,
                "selectedId": selected_id,
                "selectedLabel": selected_option.get("label", ""),
                "thought": thought,
            },
            data={
                "actionName": "CHOOSE_OPTION",
                "selectedOption": selected_option,
                "thought": thought,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


choose_option_action = Action(
    name=ChooseOptionAction.name,
    similes=ChooseOptionAction().similes,
    description=ChooseOptionAction.description,
    validate=ChooseOptionAction().validate,
    handler=ChooseOptionAction().handler,
    examples=ChooseOptionAction().examples,
)
