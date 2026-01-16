from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import REPLY_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType
from elizaos.utils.spec_examples import convert_spec_examples

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

# Get text content from centralized specs
_spec = require_action_spec("REPLY")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    return convert_spec_examples(_spec)


@dataclass
class ReplyAction:
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
        all_providers: list[str] = []
        if responses:
            for res in responses:
                if res.content and res.content.providers:
                    all_providers.extend(res.content.providers)

        state = await runtime.compose_state(
            message, [*all_providers, "RECENT_MESSAGES", "ACTION_STATE"]
        )

        template = REPLY_TEMPLATE
        if runtime.character.templates and "replyTemplate" in runtime.character.templates:
            template = runtime.character.templates["replyTemplate"]

        prompt = runtime.compose_prompt_from_state(state=state, template=template)

        response = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {
                "prompt": prompt,
                "system": str(runtime.character.system or ""),
            },
        )

        parsed = parse_key_value_xml(response)
        thought = parsed.get("thought", "") if parsed else ""
        text = parsed.get("text", "") if parsed else ""

        thought = str(thought) if thought else ""
        text = str(text) if text else ""

        response_content = Content(
            thought=thought,
            text=text,
            actions=["REPLY"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Generated reply: {text}",
            values={
                "success": True,
                "responded": True,
                "lastReply": text,
                "lastReplyTime": runtime.get_current_time_ms(),
                "thoughtProcess": thought,
            },
            data={
                "actionName": "REPLY",
                "responseThought": thought,
                "responseText": text,
                "messageGenerated": True,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


reply_action = Action(
    name=ReplyAction.name,
    similes=ReplyAction().similes,
    description=ReplyAction.description,
    validate=ReplyAction().validate,
    handler=ReplyAction().handler,
    examples=ReplyAction().examples,
)
