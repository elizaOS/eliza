from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class NoneAction:
    name: str = "NONE"
    similes: list[str] = field(default_factory=lambda: ["NO_ACTION", "NO_RESPONSE", "PASS"])
    description: str = (
        "Do nothing and skip to the next action. Use this when no specific action "
        "is required but processing should continue."
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
        return ActionResult(
            text="No action taken",
            values={"success": True, "noAction": True},
            data={"actionName": "NONE"},
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Just thinking out loud here..."),
                ),
                ActionExample(name="{{name2}}", content=Content(text="", actions=["NONE"])),
            ],
        ]


none_action = Action(
    name=NoneAction.name,
    similes=NoneAction().similes,
    description=NoneAction.description,
    validate=NoneAction().validate,
    handler=NoneAction().handler,
    examples=NoneAction().examples,
)
