from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.prompts import CHOOSE_OPTION_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class ChooseOptionAction:
    name: str = "CHOOSE_OPTION"
    similes: list[str] = field(
        default_factory=lambda: ["SELECT_OPTION", "PICK_OPTION", "SELECT_TASK", "PICK_TASK"]
    )
    description: str = (
        "Choose an option from available choices. Used for task selection "
        "and decision-making when multiple options are presented."
    )

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
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Which task should we work on first?"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll select the most urgent task.",
                        actions=["CHOOSE_OPTION"],
                    ),
                ),
            ],
        ]


choose_option_action = Action(
    name=ChooseOptionAction.name,
    similes=ChooseOptionAction().similes,
    description=ChooseOptionAction.description,
    validate=ChooseOptionAction().validate,
    handler=ChooseOptionAction().handler,
    examples=ChooseOptionAction().examples,
)
