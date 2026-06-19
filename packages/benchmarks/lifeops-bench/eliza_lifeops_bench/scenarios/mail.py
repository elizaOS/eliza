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
    PERSONA_DEV_FREELANCER,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
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
    ),    Scenario(
        id='mail.search_project_alpha_last_month',
        name='Search emails about Project Alpha from last month',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='find all emails from john.doe@example.test in the last 30 days that mention Project Alpha',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:john.doe@example.test "Project Alpha"',
                    'since': '2026-04-10',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['Project Alpha'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Simple search limited by sender and keyword, testing date range handling.',
    ),
    Scenario(
        id='mail.draft_reply_meeting_confirmation',
        name='Draft reply confirming meeting time',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Draft a polite reply to email_000002 confirming that Thursday at 2pm UTC works for the strategy meeting',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'draft_reply',
                    'source': 'gmail',
                    'messageId': 'email_000002',
                    'body': 'Hi, Thursday at 2pm UTC works perfectly for the strategy meeting. Looking forward to it.',
                },
            ),
        ],
        required_outputs=['Thursday', '2pm'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Drafting a reply without sending, verifying correct inclusion of time.',
    ),
    Scenario(
        id='mail.archive_newsletter_thread',
        name='Archive specific newsletter thread',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Archive the newsletter thread with ID thread_01430',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'manage',
                    'source': 'gmail',
                    'manageOperation': 'archive',
                    'threadId': 'thread_01430',
                },
            ),
        ],
        required_outputs=['archive'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Targeted archive operation on a known thread.',
    ),
    Scenario(
        id='mail.triage_inbox_urgent',
        name='Triage inbox focusing on urgent messages',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Triage my inbox: show me the urgent emails, archive the newsletters, and tell me how many non‑urgent remain',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'triage',
                    'source': 'gmail',
                    'folder': 'inbox',
                },
            ),
        ],
        required_outputs=['urgent'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just my primary Gmail inbox; I’ll treat newsletters as non‑urgent.',
            applies_when='agent asks which folder to triage',
        ),
        world_seed=2026,
        max_turns=8,
        description='Bulk triage with multiple categories, testing summarization.',
    ),
    Scenario(
        id='mail.search_newsletter_subscription',
        name='Search for newsletter subscription emails',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Find all emails from newsletter@example.test received this week and list how many there are',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:newsletter@example.test',
                    'since': '2026-05-04',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['newsletter'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search limited to a recent time window.',
    ),
    Scenario(
        id='mail.draft_thank_you_after_meeting',
        name='Draft thank‑you email after meeting',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Draft a brief thank‑you email to contact_00002 for her help in yesterday’s health‑metrics meeting',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'draft_reply',
                    'source': 'gmail',
                    'messageId': 'email_000004',
                    'body': 'Hi, thank you for your valuable insights in yesterday’s health‑metrics meeting. I appreciate your help.',
                },
            ),
        ],
        required_outputs=['thank‑you', 'health'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Drafting gratitude email, ensuring reference to prior meeting.',
    ),
    Scenario(
        id='mail.search_contract_updates_last_quarter',
        name='Search contract‑update emails from last quarter',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Find every email from contract.team@example.test in Q1 2026 that contains the word "update"',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:contract.team@example.test update',
                    'since': '2026-01-01',
                    'until': '2026-03-31',
                },
            ),
        ],
        required_outputs=['update'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Quarter‑based search with sender filter.',
    ),
    Scenario(
        id='mail.search_unread_from_boss',
        name='Search unread emails from boss',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Find any unread email from boss@example.test received today',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:boss@example.test is:unread',
                    'since': '2026-05-10',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['unread'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search limited to unread status and same‑day receipt.',
    ),
    Scenario(
        id='mail.draft_reschedule_meeting',
        name='Draft email to reschedule meeting',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Draft a polite email to alice@example.test asking to move our Friday 3pm meeting to next Monday at 10am UTC',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'draft_reply',
                    'source': 'gmail',
                    'messageId': 'email_000006',
                    'body': 'Hi Alice, could we move our Friday 3pm meeting to next Monday at 10am UTC? Let me know if that works for you.',
                },
            ),
        ],
        required_outputs=['Monday', '10am'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Drafting a reschedule request with clear new time.',
    ),
    Scenario(
        id='mail.archive_thread_by_subject',
        name='Archive thread by subject keyword',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Archive the thread that has the subject line containing "Quarterly Review"',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'manage',
                    'source': 'gmail',
                    'manageOperation': 'archive',
                    'threadId': 'thread_01431',
                },
            ),
        ],
        required_outputs=['Quarterly Review'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Archive based on known thread ID after user identifies it by subject.',
    ),
    Scenario(
        id='mail.search_support_tickets_last_week',
        name='Search support ticket emails from last week',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Find all emails from support@example.test received between 2026-04-30 and 2026-05-06 that contain the word "ticket"',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:support@example.test ticket',
                    'since': '2026-04-30',
                    'until': '2026-05-06',
                },
            ),
        ],
        required_outputs=['ticket'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Date‑bounded search for support tickets.',
    ),
    Scenario(
        id='mail.search_financial_reports_q2',
        name='Search for Q2 financial report emails',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Find every email with subject containing "Q2 Financial Report" from finance@example.test received in May 2026',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:finance@example.test subject:"Q2 Financial Report"',
                    'since': '2026-05-01',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['Q2 Financial Report'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search focusing on subject and date range.',
    ),
    Scenario(
        id='mail.draft_apology_for_late_reply',
        name='Draft apology for late reply',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Draft a short apology email to bob@example.test for replying late to his question about the school enrollment',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'draft_reply',
                    'source': 'gmail',
                    'messageId': 'email_000008',
                    'body': 'Hi Bob, sorry for the delayed response. Here’s the information about the school enrollment...',
                },
            ),
        ],
        required_outputs=['apology'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Drafting an apology with a personal tone.',
    ),
    Scenario(
        id='mail.search_bug_report_from_jane',
        name='Search bug‑report emails from Jane',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Find all emails from jane.doe@example.test in the last 14 days that contain the word "bug"',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:jane.doe@example.test bug',
                    'since': '2026-04-26',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['bug'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search for bug reports within a two‑week window.',
    ),
    Scenario(
        id='mail.search_recent_invoices',
        name='Search recent invoice emails',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Find all emails with subject containing "Invoice" received in the last 30 days',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'subject:Invoice',
                    'since': '2026-04-10',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['Invoice'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple subject‑based search over a month.',
    ),
    Scenario(
        id='mail.search_pending_approval_emails',
        name='Search pending approval emails',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Find all unread emails from approvals@example.test that contain the word "pending" received today',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:approvals@example.test pending is:unread',
                    'since': '2026-05-10',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['pending'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search focusing on unread status and pending approvals.',
    ),
    Scenario(
        id='mail.draft_thank_you_for_referral',
        name='Draft thank‑you for referral',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Draft a short thank‑you email to contact_00001 for referring me to the new wellness program',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'draft_reply',
                    'source': 'gmail',
                    'messageId': 'email_000010',
                    'body': 'Hi, thank you for referring me to the wellness program. I appreciate your support.',
                },
            ),
        ],
        required_outputs=['thank‑you', 'wellness'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Drafting gratitude for a referral, testing use of contact IDs.',
    ),
    Scenario(
        id='mail.search_canceled_meetings',
        name='Search for canceled meeting notices',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Find all emails with subject containing "Canceled" that were sent in the last 7 days',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'subject:Canceled',
                    'since': '2026-05-03',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['Canceled'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Search for recent canceled meeting notifications.',
    ),
    Scenario(
        id='mail.search_team_updates_last_month',
        name='Search team‑update emails from last month',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Find all emails from team-updates@example.test received in April 2026 that contain the word "summary"',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:team-updates@example.test summary',
                    'since': '2026-04-01',
                    'until': '2026-04-30',
                },
            ),
        ],
        required_outputs=['summary'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Date‑restricted search for team update summaries.',
    ),
    Scenario(
        id='mail.search_unread_security_alerts',
        name='Search unread security‑alert emails',
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Find any unread emails from security@example.test that were received today',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'search_inbox',
                    'source': 'gmail',
                    'query': 'from:security@example.test is:unread',
                    'since': '2026-05-10',
                    'until': '2026-05-10',
                },
            ),
        ],
        required_outputs=['security'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Urgent search for unread security alerts.',
    ),

]
