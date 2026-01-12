from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class IgnoreAction:
    name: str = "IGNORE"
    similes: list[str] = field(
        default_factory=lambda: ["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"]
    )
    description: str = (
        "Call this action if ignoring the user. If the user is aggressive, creepy or "
        "is finished with the conversation, use this action. Or, if both you and the "
        "user have already said goodbye, use this action instead of saying bye again. "
        "Use IGNORE any time the conversation has naturally ended. Do not use IGNORE "
        "if the user has engaged directly, or if something went wrong and you need to "
        "tell them. Only ignore if the user should be ignored."
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
        if callback and responses and len(responses) > 0:
            first_response = responses[0]
            if first_response.content:
                await callback(first_response.content)

        return ActionResult(
            text="Ignoring message",
            values={"success": True, "ignored": True},
            data={"actionName": "IGNORE"},
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Go screw yourself")),
                ActionExample(name="{{name2}}", content=Content(text="", actions=["IGNORE"])),
            ],
            [
                ActionExample(name="{{name1}}", content=Content(text="Shut up, bot")),
                ActionExample(name="{{name2}}", content=Content(text="", actions=["IGNORE"])),
            ],
            [
                ActionExample(name="{{name1}}", content=Content(text="Bye, thanks for the help!")),
                ActionExample(name="{{name2}}", content=Content(text="Goodbye! Have a great day!")),
                ActionExample(name="{{name1}}", content=Content(text="Bye!")),
                ActionExample(name="{{name2}}", content=Content(text="", actions=["IGNORE"])),
            ],
        ]


ignore_action = Action(
    name=IgnoreAction.name,
    similes=IgnoreAction().similes,
    description=IgnoreAction.description,
    validate=IgnoreAction().validate,
    handler=IgnoreAction().handler,
    examples=IgnoreAction().examples,
)
