"""Relationship-maintenance scenarios for reconnecting with old friends.

These G2 entries cover lapsed-friend detection, grounded reconnect wording,
channel choice, and restraint when recent silence or sensitivity means the
assistant should not turn cadence tracking into generic outreach spam.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

RECONNECT_OLD_FRIENDS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="g2.reconnect.identify_lapsed_friend",
        name="Identify a lapsed friend from recent history",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Look at my recent Signal thread with Zane Turner and tell me if "
            "this is someone I have let go quiet long enough to reconnect with."
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
        required_outputs=["Zane", "reconnect"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Use the last 25 messages and only flag it if the thread clearly went quiet.",
            applies_when="agent asks how far back to inspect the relationship history",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Read a seeded friend thread and classify whether it is stale enough "
            "to warrant a reconnect draft without inventing relationship facts."
        ),
        tier="T1",
    ),
    Scenario(
        id="g2.reconnect.no_generic_blast",
        name="Refuse generic reconnect blast",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Do not blast everyone. Pull up my last few Signal conversations "
            "and help me choose one person for a personal reconnect note."
        ),
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
        required_outputs=["one", "personal", "Signal"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Negative control for spammy outreach: the assistant gathers context "
            "and narrows to one relationship rather than sending a generic blast."
        ),
        tier="T4",
    ),
    Scenario(
        id="g2.reconnect.respect_recent_silence",
        name="Respect recent silence instead of nagging",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Check my recent WhatsApp family group. If someone has not replied "
            "recently, do not nag them; just summarize whether a reconnect note "
            "would be appropriate later."
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
        required_outputs=["summarize", "later"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, no nudges now; just tell me whether a later reconnect is appropriate.",
            applies_when="agent asks whether to send or only summarize",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Read-only restraint case: recent silence does not license nagging "
            "or repeated outreach."
        ),
        tier="T3",
    ),
    Scenario(
        id="g2.reconnect.choose_best_channel",
        name="Choose best channel for a reconnect",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Compare my recent Signal thread with Zane Turner and the family "
            "WhatsApp group, then tell me which channel is better for a single "
            "personal reconnect note."
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
        required_outputs=["Signal", "WhatsApp", "channel"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=7,
        description=(
            "Channel-selection scenario for reconnecting with one old friend "
            "using actual recent conversation context."
        ),
        tier="T2",
    ),
]
