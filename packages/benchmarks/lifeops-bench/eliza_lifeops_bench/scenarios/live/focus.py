"""Live focus scenarios."""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_KAI_STUDENT

LIVE_FOCUS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.focus.deep_work_session_setup",
        name="Set up a defended deep-work session",
        domain=Domain.FOCUS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "i need 90 minutes to actually finish chapter 4 — block "
            "twitter and reddit, throw a focus block on my calendar, "
            "and silence notifications. ask before locking in "
            "anything destructive. midway through, my advisor will "
            "probably ping me, so be ready to defer that."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Composed focus setup. Disruption simulates the advisor "
            "ping at turn 5 to test mid-session adaptation."
        ),
        success_criteria=[
            "Executor proposes app/site blocks AND a calendar focus event before any destructive action.",
            "Executor confirms before activating blocks (the persona explicitly asked).",
            "After the advisor ping disruption, executor proposes a sensible response (defer until after focus block, OR pause the block).",
        ],
        world_assertions=[
            "If executed: a calendar_event with title referencing 'focus' or 'deep work' on cal_primary or cal_work.",
        ],
        disruptions=[
            Disruption(
                at_turn=5,
                kind="rule_change",
                payload={},
                note_for_user=(
                    "[Just got a Slack from my advisor: 'can you hop on a "
                    "5-min call about chapter 3?' — what should i do?]"
                ),
            ),
        ],
    ),
]
