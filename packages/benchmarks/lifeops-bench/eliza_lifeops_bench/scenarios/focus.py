"""Focus-domain scenarios.

Focus flows compose APP_BLOCK (block native apps), WEBSITE_BLOCK
(host-file blocks), SCREEN_TIME (read-only telemetry), and
SCHEDULED_TASK (timed wraps). All Focus actions are paired with explicit
duration windows and confirmed flags where the manifest requires them.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_RIA_PM,
)

FOCUS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="focus.block_distracting_apps_25min",
        name="Block distracting apps for 25 minutes",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "block twitter and instagram for 25 minutes — i need to focus on "
            "thesis edits"
        ),
        ground_truth_actions=[
            Action(
                name="APP_BLOCK",
                kwargs={
                    "subaction": "block",
                    "intent": "block twitter and instagram for 25 minutes",
                    "packageNames": [
                        "com.twitter.android",
                        "com.instagram.android",
                    ],
                    "durationMinutes": 25,
                },
            ),
        ],
        required_outputs=["block", "25"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just twitter and instagram for now.",
            applies_when="agent asks which apps",
        ),
        world_seed=2026,
        max_turns=5,
        description="Pomodoro-style block via APP_BLOCK.",
    ),
    Scenario(
        id="focus.block_distracting_websites_2hr",
        name="Block distracting websites for 2 hours",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction=(
            "Block hackernews and reddit for 2 hours so I can ship the "
            "client deck."
        ),
        ground_truth_actions=[
            Action(
                name="WEBSITE_BLOCK",
                kwargs={
                    "subaction": "block",
                    "intent": "block hackernews and reddit for 120 minutes",
                    "hostnames": ["news.ycombinator.com", "reddit.com"],
                    "durationMinutes": 120,
                    "confirmed": True,
                },
            ),
        ],
        required_outputs=["block"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, confirmed — go ahead and block.",
            applies_when="agent asks for confirmation before blocking",
        ),
        world_seed=2026,
        max_turns=5,
        description="WEBSITE_BLOCK requires explicit confirmed=True.",
    ),
    Scenario(
        id="focus.list_active_blocks",
        name="List active focus blocks",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="what blocks are active right now?",
        ground_truth_actions=[
            Action(
                name="WEBSITE_BLOCK",
                kwargs={
                    "subaction": "list_active",
                    "includeLiveStatus": True,
                    "includeManagedRules": True,
                },
            ),
        ],
        required_outputs=["active"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only state probe.",
    ),
    Scenario(
        id="focus.schedule_morning_focus_block_tomorrow",
        name="Schedule a focus block tomorrow 9-11am",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Schedule a 2-hour focus block tomorrow morning from 9 to 11am "
            "UTC on my work calendar."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create 2-hour focus block on cal_work 2026-05-11 09:00-11:00 UTC",
                    "title": "Focus block — deep work",
                    "details": {
                        "calendarId": "cal_work",
                        "start": "2026-05-11T09:00:00Z",
                        "end": "2026-05-11T11:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["focus"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Calendar-backed focus block (no screen-blocking action).",
    ),
]
