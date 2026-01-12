from __future__ import annotations

from dataclasses import dataclass
from elizaos_plugin_planning.actions.analyze_input import ActionExample


@dataclass
class ExecuteFinalAction:

    @property
    def name(self) -> str:
        return "EXECUTE_FINAL"

    @property
    def similes(self) -> list[str]:
        return ["FINALIZE", "COMPLETE"]

    @property
    def description(self) -> str:
        return "Executes the final action based on processing results"

    async def validate(self, message_text: str) -> bool:
        return True

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        decisions = params.get("decisions")
        if not decisions or not isinstance(decisions, dict):
            raise ValueError("Missing 'decisions' parameter")

        requires_action = decisions.get("requiresAction", False)
        suggested_response = decisions.get("suggestedResponse", "Done.")

        return {
            "action": "EXECUTE_FINAL",
            "executedAction": "RESPOND" if requires_action else "ACKNOWLEDGE",
            "message": suggested_response,
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Execute the final step",
                output="Completing the chain...",
            ),
        ]
