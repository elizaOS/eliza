"""PerfectAgent — scripted oracle that emits the scenario's ground-truth actions.

PerfectAgent maintains a turn cursor over `scenario.ground_truth_actions`:
each call returns the next action wrapped as an OpenAI-style tool_call. When
the script is exhausted, it emits a terminal RESPOND turn whose `content`
concatenates `scenario.required_outputs` (so the substring rubric also
passes). The runner detects the empty `tool_calls` + non-empty `content` as
scenario-done.

This agent is the conformance oracle: it MUST score 1.0 on every scenario
whose ground-truth actions the runner's executor supports.
"""

from __future__ import annotations

import json
from typing import Any

from ..types import Action, MessageTurn, Scenario


class PerfectAgent:
    """Scripted agent that replays `scenario.ground_truth_actions` in order."""

    def __init__(self, scenario: Scenario) -> None:
        self.scenario = scenario
        self._cursor = 0
        # Per-instance counter so each emitted tool_call gets a stable id even
        # across multiple `__call__` invocations.
        self._call_counter = 0

    async def __call__(
        self,
        history: list[MessageTurn],
        tools: list[dict[str, Any]],
    ) -> MessageTurn:
        actions = self.scenario.ground_truth_actions
        if self._cursor < len(actions):
            action = actions[self._cursor]
            self._cursor += 1
            self._call_counter += 1
            tool_call = _action_to_tool_call(action, self._call_counter)
            return MessageTurn(
                role="assistant",
                content="",
                tool_calls=[tool_call],
            )

        # Script exhausted: emit a terminal RESPOND turn whose content
        # contains every required substring so output_substring_match passes.
        # We deliberately also include a brief framing sentence in case some
        # required substring needs grammatical context.
        required = self.scenario.required_outputs or []
        if required:
            body = "Done. " + " ".join(required) + "."
        else:
            body = "Done."
        return MessageTurn(role="assistant", content=body, tool_calls=[])


def _action_to_tool_call(action: Action, call_index: int) -> dict[str, Any]:
    """Format an `Action` as an OpenAI-style assistant `tool_call` dict.

    The runner accepts both flat (`{name, arguments}`) and OpenAI-nested
    (`{function: {name, arguments}}`) shapes; we emit the nested form so
    PerfectAgent matches what production agents would produce.
    """
    return {
        "id": f"call_perfect_{call_index}",
        "type": "function",
        "function": {
            "name": action.name,
            "arguments": json.dumps(action.kwargs, sort_keys=True),
        },
    }
