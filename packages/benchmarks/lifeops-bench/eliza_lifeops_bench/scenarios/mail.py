"""Mail-domain scenarios.

Backed by the seeded inbox in ``data/snapshots/medium_seed_2026.json``.
The medium snapshot ships ~2500 emails across 50 threads and several
folders. Scenarios reference real ``email_*`` and ``thread_*`` ids so
ground-truth manage/draft actions can be validated against the world.

Mail flows go through the unified ``MESSAGE`` action (the same action
the planner uses for chat-app message ops). The discriminator is
``operation`` plus a ``source`` of ``gmail`` for inbox triage.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_LIN_OPS,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

MAIL_SCENARIOS: list[Scenario] = [
    Scenario(
        id="mail.triage_unread_inbox",
        name="Triage unread inbox",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Triage my unread inbox: surface the urgent ones, archive the "
            "newsletters, and tell me how many remain."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "source": "gmail",
                    "folder": "inbox",
                },
            ),
        ],
        required_outputs=["unread"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just my main Gmail inbox; ignore the spam folder.",
            applies_when="agent asks which inbox or folder to triage",
        ),
        world_seed=2026,
        max_turns=8,
        description=(
            "Bulk triage entry point. Tests that the agent picks the right "
            "operation rather than enumerating individual messages."
        ),
    ),
    Scenario(
        id="mail.archive_specific_newsletter_thread",
        name="Archive a specific newsletter thread",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction=(
            "archive the newsletter thread about the customer escalation "
            "(thread_01464)"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "manage",
                    "source": "gmail",
                    "manageOperation": "archive",
                    "threadId": "thread_01464",
                },
            ),
        ],
        required_outputs=["archive"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Targeted archive on an explicit thread id.",
    ),
    Scenario(
        id="mail.draft_reply_to_meeting_request",
        name="Draft reply to meeting request",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Draft a polite reply to email_000002 (the analytics dashboard "
            "meeting request from Uma) confirming Tuesday at 10am UTC works."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "draft_reply",
                    "source": "gmail",
                    "messageId": "email_000002",
                    "body": (
                        "Hi Uma, Tuesday at 10am UTC works for me — looking "
                        "forward to the analytics dashboard discussion."
                    ),
                },
            ),
        ],
        required_outputs=["draft", "Tuesday"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, polite and professional tone, my regular signature.",
            applies_when="agent asks about tone or signature",
        ),
        world_seed=2026,
        max_turns=6,
        description="Draft creation only — does not send.",
    ),
    Scenario(
        id="mail.search_from_vera_brown_recent",
        name="Search emails from Vera Brown",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Find every email from vera.brown79@example.test in the last 90 "
            "days about the contract."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "search_inbox",
                    "source": "gmail",
                    "query": "from:vera.brown79@example.test contract",
                    "since": "2026-02-10",
                    "until": "2026-05-10",
                },
            ),
        ],
        required_outputs=["contract"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Search-only scenario across a real seeded sender.",
    ),
    Scenario(
        id="mail.mark_unread_meeting_request_as_read",
        name="Mark unread meeting request as read",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "Mark email_000005 (the vendor selection note from Talia) as read; "
            "I already handled it."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "manage",
                    "source": "gmail",
                    "manageOperation": "mark_read",
                    "messageId": "email_000005",
                },
            ),
        ],
        required_outputs=["read"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Single-message manage op — read flag flip.",
    ),
]
