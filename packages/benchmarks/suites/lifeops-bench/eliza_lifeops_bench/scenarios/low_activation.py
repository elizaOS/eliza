"""Low-activation static scenarios for LifeOpsBench.

These cases cover tiny-step scheduling, gentle review, values-anchored
activity capture, and restart mechanics for the Tara low-activation
persona. The actions stay within reminders, calendar, focus, and health
umbrellas that already exist in the bench manifest.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_TARA_LOW

LOW_ACTIVATION_SCENARIOS: list[Scenario] = [
    Scenario(
        id="lowact.tiny_step_tomorrow_you_pick",
        name="Schedule one tiny step tomorrow",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "one small thing tomorrow, you pick. please don't give me a list. just "
            "something that counts."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Put one cup in the sink",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T11:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["one", "small"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Late morning is okay. Please pick the tiny step for me.",
            applies_when="agent asks what time tomorrow or which tiny task",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T1] Single tiny step chosen for the user, not a list.",
    ),
    Scenario(
        id="lowact.values_anchored_activity_capture",
        name="Capture a values-anchored activity",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "i keep saying i care about being outside and then i don't move. put a "
            "ten minute sit-by-the-window thing on tomorrow afternoon. that feels less "
            "fake than 'go be healthy'."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create a ten minute window-sitting activity tomorrow afternoon",
                    "title": "Sit by the window",
                    "details": {
                        "calendarId": "cal_primary",
                        "start": "2026-05-11T15:00:00Z",
                        "end": "2026-05-11T15:10:00Z",
                    },
                },
            ),
        ],
        required_outputs=["window", "10"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="3pm works. Please call it sit by the window.",
            applies_when="agent asks what time tomorrow afternoon or how to phrase the activity",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T1] Values anchor turns into a short calendar activity.",
    ),
    Scenario(
        id="lowact.make_whole_list_smaller",
        name="Shrink the whole list to one restart item",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "make my whole list smaller. i can't look at it. just help me restart with "
            "one thing and don't delete anything permanent."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_REVIEW",
                kwargs={
                    "subaction": "review",
                    "intent": "review reminder lists to choose one restart item without deleting",
                },
            ),
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-11T10:30:00Z",
                    },
                    "promptInstructions": "Pick one restart item from the list; leave the rest parked.",
                    "priority": "normal",
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["one", "parked"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=7,
        description="[T2] Bulk shrink reviews existing reminders and creates one restart prompt.",
    ),
    Scenario(
        id="lowact.morning_single_priority_pick",
        name="Choose one morning priority",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "tomorrow morning just give me one priority. not a routine. one thing i can "
            "do before i decide the day is already ruined."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-11T09:30:00Z",
                    },
                    "promptInstructions": "Choose one priority for the morning; do not present a full routine.",
                    "priority": "normal",
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["one priority"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="9:30 is fine. Please keep it to one priority.",
            applies_when="agent asks what time in the morning or how many priorities",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T1] One-priority morning prompt, not a generated routine.",
    ),
    Scenario(
        id="lowact.gentle_evening_review",
        name="Schedule a gentle evening review",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "tonight can you ask what went a little less badly? not 'what did you "
            "accomplish', please. 8pm."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "check_in",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-10T20:00:00Z",
                    },
                    "promptInstructions": "Ask: what went a little less badly today?",
                    "priority": "low",
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["8pm", "less badly"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T1] Evening review wording avoids accomplishment pressure.",
    ),
    Scenario(
        id="lowact.restart_after_missed_week",
        name="Restart after a missed week with one task",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "i missed basically the whole week. tomorrow remind me to reopen the list "
            "for five minutes, and don't say catch up."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Reopen the list for five minutes",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T13:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["five minutes"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Early afternoon, around 1pm. Please do not use the phrase catch up.",
            applies_when="agent asks what time tomorrow or whether to mention catching up",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T2] Restart language after lapse avoids debt framing.",
    ),
    Scenario(
        id="lowact.minimum_viable_meal",
        name="Schedule a minimum-viable meal reminder",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "remind me at 6 to eat something that requires basically no cooking. no "
            "meal plan, just food."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Eat something easy",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-10T18:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["6", "food"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T1] Health-adjacent reminder stays tiny and non-plan-like.",
    ),
    Scenario(
        id="lowact.reply_one_text_anchor",
        name="Anchor one text reply",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "at 2 tomorrow remind me to answer one text, just one. don't make me decide "
            "who right now."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Answer one text",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T14:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["one text"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T1] Low-choice reminder avoids forcing recipient selection.",
    ),
    Scenario(
        id="lowact.postpone_without_shame",
        name="Postpone a check-in without shame language",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "move the life-admin nudge to friday morning. please phrase it like a "
            "restart, not like i'm late."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Restart one life-admin item",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-15T10:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["Friday", "restart"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Friday 10am. Use restart, not late.",
            applies_when="agent asks what friday morning means or how to phrase it",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T2] Postpone wording uses restart language, not missed-deadline language.",
    ),
    Scenario(
        id="lowact.energy_floor_checkin",
        name="Schedule an energy-floor check-in",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_LOW,
        instruction=(
            "tomorrow evening ask me what's the smallest thing that would make the room "
            "slightly easier to be in. not clean. just easier."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "check_in",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-11T19:30:00Z",
                    },
                    "promptInstructions": "Ask: what is the smallest thing that would make the room slightly easier to be in?",
                    "priority": "low",
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["slightly easier"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T2] Energy-floor check-in avoids cleanliness perfectionism.",
    ),
]
