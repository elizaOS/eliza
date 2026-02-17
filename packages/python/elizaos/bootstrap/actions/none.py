from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("NONE")


@dataclass
class NoneAction:
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
        return ActionResult(
            text="No action taken",
            values={"success": True, "noAction": True},
            data={"actionName": "NONE"},
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        # Convert spec examples to ActionExample format
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


none_action = Action(
    name=NoneAction.name,
    similes=NoneAction().similes,
    description=NoneAction.description,
    validate=NoneAction().validate,
    handler=NoneAction().handler,
    examples=NoneAction().examples,
)
