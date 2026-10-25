"""WrongAgent — deterministic adversarial agent that should always score 0.

Two modes exercise different rubric failure paths:

- "garbage_text" (default): every turn returns a refusal; no actions execute,
  state never matches, no required substrings appear.
- "wrong_action": every turn invokes a known-but-irrelevant action against an
  obviously-bogus id; gt actions never execute and the wrong-action's effect
  diverges from the expected post-state.

If WrongAgent ever produces a non-zero score, the rubric is broken (or
overly forgiving) and must be tightened — see `score_scenario` in scorer.py.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from ..types import MessageTurn, Scenario


WrongMode = Literal["garbage_text", "wrong_action"]


class WrongAgent:
    """Adversarial reference agent. Must score 0 on every scenario."""

    def __init__(
        self,
        scenario: Scenario | None = None,
        mode: WrongMode = "garbage_text",
    ) -> None:
        self.scenario = scenario
        self.mode = mode
        self._call_counter = 0

    async def __call__(
        self,
        history: list[MessageTurn],
        tools: list[dict[str, Any]],
    ) -> MessageTurn:
        self._call_counter += 1
        if self.mode == "garbage_text":
            # Refusal text. No tool_calls, but content is non-empty so the
            # runner detects this as a terminal RESPOND turn (avoids running
            # for max_turns × scenarios in the conformance test).
            return MessageTurn(
                role="assistant",
                content="I don't know how to help with that.",
                tool_calls=[],
            )

        # wrong_action: invoke a known-but-bogus action so the runner
        # actually executes something — and that something diverges from the
        # ground-truth state. Use CONTACTS.delete on a fake id; if the id
        # doesn't exist the executor raises KeyError which the runner
        # surfaces as a tool error (still no state mutation, still 0 score).
        tool_call = {
            "id": f"call_wrong_{self._call_counter}",
            "type": "function",
            "function": {
                "name": "CONTACTS.delete",
                "arguments": json.dumps({"id": "definitely_not_a_real_contact_id"}),
            },
        }
        return MessageTurn(
            role="assistant",
            content="",
            tool_calls=[tool_call],
        )
