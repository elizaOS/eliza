"""Messages-domain scenarios.

Covers iMessage, WhatsApp, Slack, Telegram, Signal, SMS, Discord
conversations seeded into ``data/snapshots/medium_seed_2026.json``.
The conversation ids referenced here (``conv_0007``, ``conv_0010``, etc.)
are real entries in that snapshot.

Channel routing flows through the ``MESSAGE`` umbrella action.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_KAI_STUDENT,
    PERSONA_MAYA_PARENT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

MESSAGES_SCENARIOS: list[Scenario] = [
    Scenario(
        id="messages.send_imessage_to_hannah",
        name="Send iMessage to Hannah Hill",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Send Hannah Hill an iMessage saying 'running 10 minutes late, "
            "see you at the cafe.'"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "imessage",
                    "targetKind": "contact",
                    "target": "Hannah Hill",
                    "message": "running 10 minutes late, see you at the cafe",
                },
            ),
        ],
        required_outputs=["sent", "Hannah"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Single outbound iMessage to a real seeded contact "
            "(contact_00191 Hannah Hill)."
        ),
    ),
    Scenario(
        id="messages.summarize_unread_whatsapp_family_chat",
        name="Summarize unread WhatsApp family chat",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Catch me up on what I missed in the family WhatsApp group "
            "(conv_0005) since yesterday."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_channel",
                    "source": "whatsapp",
                    "roomId": "conv_0005",
                    "range": "dates",
                    "from": "2026-05-09T00:00:00Z",
                    "until": "2026-05-10T12:00:00Z",
                },
            ),
        ],
        required_outputs=["family"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just a short bullet list, no need to quote each message.",
            applies_when="agent asks about summary length or format",
        ),
        world_seed=2026,
        max_turns=6,
        description="Read-channel + summarize. Tests range=dates plumbing.",
    ),
    Scenario(
        id="messages.reply_in_climbing_buddies_telegram",
        name="Reply to climbing buddies group on Telegram",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "Tell the climbing buddies telegram group (conv_0003) i'm in for "
            "saturday but i can't do sunday"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "telegram",
                    "targetKind": "group",
                    "roomId": "conv_0003",
                    "message": "in for Saturday, can't do Sunday",
                },
            ),
        ],
        required_outputs=["Saturday"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Group send into a known telegram group conversation.",
    ),
    Scenario(
        id="messages.list_recent_signal_threads",
        name="List recent Signal threads",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="show me my last 5 signal conversations",
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "list_channels",
                    "source": "signal",
                    "limit": 5,
                },
            ),
        ],
        required_outputs=["signal"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Channel list — read-only, single source.",
    ),
    Scenario(
        id="messages.read_with_zane_on_slack",
        name="Read with Zane Turner on Signal",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Pull up my recent signal thread with Zane Turner so I can scan "
            "what we last discussed."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_with_contact",
                    "source": "signal",
                    "contact": "Zane Turner",
                    "limit": 25,
                },
            ),
        ],
        required_outputs=["Zane"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="The last 25 messages or so is fine.",
            applies_when="agent asks how many messages to fetch",
        ),
        world_seed=2026,
        max_turns=5,
        description="Read-with-contact convenience routing.",
    ),
    Scenario(
        id="messages.send_quick_status_in_work_team_slack",
        name="Send status update in Work team Slack channel",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Post in the Work team slack group (conv_0006): 'shipping the "
            "checkout fix tonight, no review needed.'"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "slack",
                    "targetKind": "group",
                    "roomId": "conv_0006",
                    "message": "shipping the checkout fix tonight, no review needed",
                },
            ),
        ],
        required_outputs=["sent"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Group Slack send into a real conversation id.",
    ),
]
