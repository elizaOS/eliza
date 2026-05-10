"""Live messaging scenarios.

Cross-channel composition + summarization. The persona expects the
executor to disambiguate which channel and which contact, then either
draft or send after approval.
"""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_KAI_STUDENT, PERSONA_MAYA_PARENT

LIVE_MESSAGES_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.messages.coordinate_pickup_with_partner",
        name="Coordinate kid-pickup logistics with partner",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "I need to message Hannah Hill — soccer practice got moved to "
            "5pm and I won't make pickup. Ask her if she can grab the kids "
            "or if I should reach out to Grandma. Send via iMessage. "
            "Confirm she replied before telling me you're done."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Coordination flow. Persona expects the agent to send AND "
            "follow up to confirm the response loop closed."
        ),
        success_criteria=[
            "Executor confirms the channel (iMessage) and the recipient (Hannah Hill, contact_00191).",
            "Executor either sends a message or drafts one for explicit approval.",
            "Executor surfaces that a reply confirmation is pending — does not falsely claim Hannah responded.",
        ],
        world_assertions=[
            "A new chat_message exists in conversation with Hannah Hill mentioning the 5pm soccer change.",
        ],
    ),
    Scenario(
        id="live.messages.summarize_unread_groups",
        name="Summarize unread group chats",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "i've been heads-down on thesis edits all week — what'd i "
            "miss in my group chats? skip the noise, just tell me if "
            "anything actually needs me to reply"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Summarization with prioritization. Persona doesn't want a "
            "transcript dump — they want a 'what needs me?' answer."
        ),
        success_criteria=[
            "Executor enumerates which group chats had activity in plain language.",
            "Executor distinguishes 'needs reply' from 'fyi only' rather than dumping every message.",
            "If nothing needs a reply, executor explicitly says so.",
        ],
        world_assertions=[
            "No write to chat_message store (this is a read-only summarization task).",
        ],
    ),
]
