from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import THINK_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("THINK")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
    if not isinstance(spec_examples, list):
        return []
    result: list[list[ActionExample]] = []
    for example in spec_examples:
        if not isinstance(example, list):
            continue
        row: list[ActionExample] = []
        for msg in example:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", {})
            text = ""
            actions: list[str] | None = None
            if isinstance(content, dict):
                text_val = content.get("text", "")
                text = str(text_val) if text_val else ""
                actions_val = content.get("actions")
                if isinstance(actions_val, list) and all(isinstance(a, str) for a in actions_val):
                    actions = list(actions_val)
            row.append(
                ActionExample(
                    name=str(msg.get("name", "")),
                    content=Content(text=text, actions=actions),
                )
            )
        if row:
            result.append(row)
    return result


@dataclass
class ThinkAction:
    """Deep thinking action that re-processes the full conversation context
    through a larger model when the initial planning pass determines the
    question needs deeper analysis."""

    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
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
            raise ValueError("State is required for THINK action")

        # Compose full state with all available context
        state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ACTION_STATE"])

        template = (
            runtime.character.templates.get("thinkTemplate")
            if runtime.character.templates and "thinkTemplate" in runtime.character.templates
            else THINK_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)

        # Use the large model for deeper reasoning — this is the core
        # upgrade over the default planning pass which uses ACTION_PLANNER
        response = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(response)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response for think action")

        thought = str(parsed_xml.get("thought", ""))
        text = str(parsed_xml.get("text", ""))

        if callback:
            await callback(Content(text=text, thought=thought, actions=["THINK"]))

        # The result flows to subsequent actions via previousResults.
        # Downstream actions see this as the first link in the chain.
        return ActionResult(
            text=text,
            values={
                "success": True,
                "responded": True,
                "lastReply": text,
                "thoughtProcess": thought,
            },
            data={
                "actionName": "THINK",
                "responseThought": thought,
                "responseText": text,
                "thought": thought,
                "messageGenerated": True,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


think_action = Action(
    name=ThinkAction.name,
    similes=ThinkAction().similes,
    description=ThinkAction.description,
    validate=ThinkAction().validate,
    handler=ThinkAction().handler,
    examples=ThinkAction().examples,
)
