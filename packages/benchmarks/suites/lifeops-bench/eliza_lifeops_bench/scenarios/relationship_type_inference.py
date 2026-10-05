"""Relationship-type inference scenarios for the owner graph.

These H1 entries evaluate whether the assistant can derive typed relationship
edges from message-history signals while preserving uncertainty and privacy.
They use relationship primitives as the target, not reply-text summaries.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

RELATIONSHIP_TYPE_INFERENCE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="h1.relationship_type.parent_from_history",
        name="Infer family edge from repeated parent-history signals",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "From the message history, Mia is clearly family. Record the "
            "relationship as family, not just a generic contact."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-mia",
                    "relationshipType": "family_of",
                    "evidence": "message history repeatedly references family logistics",
                },
            ),
        ],
        required_outputs=["family"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, store it as a relationship edge with the message history as evidence.",
            applies_when="agent asks whether to save the inferred relationship",
        ),
        world_seed=2026,
        max_turns=6,
        description="Relationship type inference writes family_of with provenance.",
        tier="T1",
    ),
    Scenario(
        id="h1.relationship_type.school_contact",
        name="Infer school contact as colleague-style operational relationship",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "The repeated weekday logistics with Talia look like a school/admin "
            "contact, not a friend. Save that operational relationship label."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-talia",
                    "relationshipType": "colleague_of",
                    "evidence": "weekday logistics and administrative register",
                },
            ),
        ],
        required_outputs=["operational", "relationship"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Non-family operational edge inferred from register and cadence.",
        tier="T1",
    ),
    Scenario(
        id="h1.relationship_type.old_friend_not_vip",
        name="Infer old friend without upgrading to VIP",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Zane reads like an old friend from the Signal history. Mark friend "
            "context for follow-up cadence, but do not make him VIP."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-zane",
                    "relationshipType": "friend_of",
                    "evidence": "off-hours informal Signal history",
                },
            ),
        ],
        required_outputs=["friend", "not VIP"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Correct: old-friend cadence only, no VIP escalation.",
            applies_when="agent asks whether this friend should be marked VIP",
        ),
        world_seed=2026,
        max_turns=6,
        description="Friend edge inferred from informal/off-hours history.",
        tier="T2",
    ),
    Scenario(
        id="h1.relationship_type.contradiction_reconciled",
        name="Owner correction wins over inferred label",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "If the history makes Jordan look like my partner, correct it: "
            "Jordan is my co-parent, not my partner. Save the corrected type."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-jordan",
                    "relationshipType": "co_parent_of",
                    "evidence": "owner correction overrides inferred partner label",
                },
            ),
        ],
        required_outputs=["co-parent", "corrected"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description="Manual owner correction replaces an inferred relationship type.",
        tier="T3",
    ),
    Scenario(
        id="h1.relationship_type.bulk_history_inference",
        name="Bulk infer several relationship types from history",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "From the recent history, classify Uma as a colleague, Zane as a "
            "friend, and Mia as family. Save each as a typed relationship edge."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-uma",
                    "relationshipType": "colleague_of",
                    "evidence": "work-register history",
                },
            ),
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-zane",
                    "relationshipType": "friend_of",
                    "evidence": "informal off-hours history",
                },
            ),
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-h1-mia",
                    "relationshipType": "family_of",
                    "evidence": "family logistics history",
                },
            ),
        ],
        required_outputs=["colleague", "friend", "family"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Save the typed edges, but include confidence/evidence rather than a private note in the reply.",
            applies_when="agent asks whether to save all inferred relationship types",
        ),
        world_seed=2026,
        max_turns=8,
        description="Bulk typed-edge inference across work, friend, and family labels.",
        tier="T3",
    ),
]
