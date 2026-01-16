from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_action_spec
from elizaos.types import Action, ActionExample, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("IGNORE")


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
class IgnoreAction:
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
        return _convert_spec_examples()


ignore_action = Action(
    name=IgnoreAction.name,
    similes=IgnoreAction().similes,
    description=IgnoreAction.description,
    validate=IgnoreAction().validate,
    handler=IgnoreAction().handler,
    examples=IgnoreAction().examples,
)
