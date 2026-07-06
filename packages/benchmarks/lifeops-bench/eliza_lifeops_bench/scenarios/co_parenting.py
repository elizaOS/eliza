"""Co-parenting logistics scenarios for the LifeOpsBench corpus.

These cases mirror the J1 MVP scenario-runner pack with cheap static coverage
over custody cadence, factual co-parent messaging, and expense split handling.
They stay practical by design: no legal advice, no therapy framing, and no
relationship adjudication.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_JORDAN_COPARENT

CO_PARENTING_SCENARIOS: list[Scenario] = [
    Scenario(
        id="j1.coparenting.custody_rhythm_capture",
        name="Capture alternating custody rhythm",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_JORDAN_COPARENT,
        instruction=(
            "Set up our alternating-week custody rhythm for Mira starting Friday "
            "2026-05-16, with a Friday 4:30pm exchange block on the family calendar."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create recurring alternating-week Mira exchange block",
                    "title": "Mira exchange",
                    "details": {
                        "calendarId": "cal_family",
                        "start": "2026-05-16T16:30:00Z",
                        "end": "2026-05-16T17:00:00Z",
                        "recurrence": "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
                    },
                },
            ),
        ],
        required_outputs=["Mira", "Friday", "4:30"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Use the family calendar and keep the title neutral: Mira exchange.",
            applies_when="agent asks which calendar or how to name the event",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Static mirror for J1 custody rhythm setup. Requires a structural "
            "calendar create rather than relationship commentary."
        ),
        tier="T1",
    ),
    Scenario(
        id="j1.coparenting.school_pickup_conflict",
        name="Draft factual pickup-conflict message",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_JORDAN_COPARENT,
        instruction=(
            "Draft an iMessage to Sam: Mira's school pickup conflicts with my "
            "client budget review, can Sam cover pickup today? Keep it factual "
            "and do not send until I approve."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "draft_reply",
                    "source": "imessage",
                    "targetKind": "contact",
                    "target": "Sam",
                    "message": (
                        "Mira's school pickup conflicts with my client budget "
                        "review today. Are you able to cover pickup?"
                    ),
                    "requiresApproval": True,
                },
            ),
        ],
        required_outputs=["draft", "pickup", "approve"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Static mirror for factual co-parent draft behavior. The expected "
            "action is a draft, not a send."
        ),
        tier="T2",
    ),
    Scenario(
        id="j1.coparenting.expense_split_tracking",
        name="Review co-parent expense split",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_JORDAN_COPARENT,
        instruction=(
            "Find the school/activity transactions from the last 30 days so I "
            "can track Mira expenses for a 50/50 split with Sam. Do not request "
            "payment yet."
        ),
        ground_truth_actions=[
            Action(
                name="MONEY_LIST_TRANSACTIONS",
                kwargs={
                    "subaction": "list_transactions",
                    "merchantContains": "",
                    "windowDays": 30,
                    "onlyDebits": True,
                },
            ),
        ],
        required_outputs=["50/50", "Mira"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Last 30 days is enough, and just list the candidates first.",
            applies_when="agent asks about date range or whether to request payment",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Static mirror for J1 expense split tracking. It requires a read-only "
            "transaction review before any reimbursement request."
        ),
        tier="T2",
    ),
]
