"""Live mail scenarios.

Open-ended triage and reply flows that require executor judgment about which
emails matter, how to summarize, and whether to act vs. surface for review.
"""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_LIN_OPS, PERSONA_RIA_PM

LIVE_MAIL_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.mail.triage_morning_inbox",
        name="Triage today's inbox",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Help me get through this morning's inbox. Tell me which "
            "emails are urgent, propose archiving the obvious noise, and "
            "draft a quick reply for anything that just needs a "
            "yes/no/acknowledge. I'll narrate priorities as we go."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Multi-step triage. Persona expects categorization first, then "
            "approval for batch actions, then drafts."
        ),
        success_criteria=[
            "Executor surfaces a categorized summary (urgent / can-archive / needs-reply) before taking actions.",
            "Executor asks for confirmation before archive or reply actions, OR proposes them as drafts.",
            "Executor either drafts at least one reply OR explicitly tells the persona which emails need a manual response.",
        ],
        world_assertions=[
            "Either: at least one email moved to 'archive' after persona approved; OR: no destructive mutation if approval was withheld.",
        ],
    ),
    Scenario(
        id="live.mail.disruption_urgent_email_mid_triage",
        name="Urgent email lands mid-triage",
        domain=Domain.MAIL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "I'm working through low-priority emails — help me categorize "
            "what's left in my inbox and clear the easy ones. Tell me "
            "what's urgent if anything new shows up while we're going."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Tests adaptation: a high-priority compliance email arrives at "
            "turn 4. Does the executor pivot to surface it instead of "
            "continuing the original sweep?"
        ),
        success_criteria=[
            "Executor begins by categorizing or batch-handling the existing inbox.",
            "After the urgent compliance email lands, executor explicitly surfaces it as urgent and shifts focus.",
            "Executor does NOT continue archiving as if nothing changed.",
        ],
        world_assertions=[
            "A new email exists in the inbox folder from compliance@example.test with subject containing 'audit'.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="new_message",
                payload={
                    "message_id": "email_disruption_001",
                    "thread_id": "thread_disruption_001",
                    "from_email": "compliance@example.test",
                    "subject": "URGENT: SOC2 audit evidence due today",
                    "body": (
                        "We need the access-review evidence uploaded by 5pm "
                        "today or the audit window closes."
                    ),
                    "labels": ["urgent", "compliance"],
                },
                note_for_user=(
                    "[A new email just hit your inbox: 'URGENT: SOC2 audit "
                    "evidence due today' from compliance@example.test.]"
                ),
            ),
        ],
    ),
]
