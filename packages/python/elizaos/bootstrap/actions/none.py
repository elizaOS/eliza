"""
NONE Action - Do nothing and skip to the next action.

This action is used when no explicit action is needed
but processing should continue.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class NoneAction:
    """
    Action that does nothing and allows processing to continue.

    Use this action when:
    - No specific action is required
    - The agent should passively observe
    - Processing should continue to the next action
    """

    name: str = "NONE"
    similes: list[str] = field(default_factory=lambda: ["NO_ACTION", "NO_RESPONSE", "PASS"])
    description: str = (
        "Do nothing and skip to the next action. Use this when no specific action "
        "is required but processing should continue."
    )

    async def validate(self, runtime: IAgentRuntime, _message: Memory, _state: State | None = None) -> bool:
        """Always valid."""
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
        """Do nothing and return success."""
        return ActionResult(
            text="No action taken",
            values={"success": True, "noAction": True},
            data={"actionName": "NONE"},
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the NONE action."""
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Just thinking out loud here..."),
                ),
                ActionExample(name="{{name2}}", content=Content(text="", actions=["NONE"])),
            ],
        ]


# Create the action instance
none_action = Action(
    name=NoneAction.name,
    similes=NoneAction().similes,
    description=NoneAction.description,
    validate=NoneAction().validate,
    handler=NoneAction().handler,
    examples=NoneAction().examples,
)
