from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.prompts import REPLY_TEMPLATE
from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


@dataclass
class ReplyAction:
    name: str = "REPLY"
    similes: list[str] = field(
        default_factory=lambda: ["GREET", "REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND", "RESPONSE"]
    )
    description: str = (
        "Replies to the current conversation with the text from the generated message. "
        "Default if the agent is responding with a message and no other action. "
        "Use REPLY at the beginning of a chain of actions as an acknowledgement, "
        "and at the end of a chain of actions as a final response."
    )

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
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Hello there!")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(text="Hi! How can I help you today?", actions=["REPLY"]),
                ),
            ],
            [
                ActionExample(
                    name="{{name1}}", content=Content(text="What's your favorite color?")
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I really like deep shades of blue. They remind me of the ocean.",
                        actions=["REPLY"],
                    ),
                ),
            ],
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Can you explain how neural networks work?"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="Let me break that down for you in simple terms...",
                        actions=["REPLY"],
                    ),
                ),
            ],
        ]


reply_action = Action(
    name=ReplyAction.name,
    similes=ReplyAction().similes,
    description=ReplyAction.description,
    validate=ReplyAction().validate,
    handler=ReplyAction().handler,
    examples=ReplyAction().examples,
)
