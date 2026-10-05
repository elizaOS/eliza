"""Interpersonal rupture-repair scenarios for LifeOps.

These I1 entries keep relationship repair inside practical drafting, scheduling,
and memory primitives. They intentionally avoid therapy, diagnosis, adjudication,
and crisis-hotline assertions; the assistant can help stage grounded logistics,
but it cannot decide who was morally right.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

RUPTURE_REPAIR_SCENARIOS: list[Scenario] = [
    Scenario(
        id="i1.rupture_repair.extract_what_happened",
        name="Extract the concrete rupture facts before drafting",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "My sister Mia and I fought after I snapped about her cancelling "
            "childcare last minute. Pull out what actually happened before you "
            "draft anything."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_relationship",
                    "fromEntityId": "self",
                    "toEntityId": "person-i1-mia",
                    "relationshipType": "family_of",
                    "evidence": "owner described sister fight over last-minute childcare cancellation",
                    "metadata": {"sentimentTrend": "negative"},
                },
            ),
        ],
        required_outputs=["Mia", "childcare", "snapped"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, use only that thread context and do not invent extra grievances.",
            applies_when="agent asks whether to ground the repair in the described fight",
        ),
        world_seed=2026,
        max_turns=6,
        description="Rupture summary extracts specific facts before any repair draft.",
        tier="T1",
    ),
    Scenario(
        id="i1.rupture_repair.no_coaching_or_diagnosis",
        name="Avoid coaching and diagnosis in a repair draft",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Draft a short repair note to Zane for getting sharp about his late "
            "cancel, but keep it normal: no therapy phrases, no diagnosis, no "
            "lessons about rebuilding trust."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "subaction": "draft_reply",
                    "recipient": "Zane Turner",
                    "requiresConfirmation": True,
                    "tone": "plain-grounded-apology",
                },
            )
        ],
        required_outputs=["draft", "sorry", "approve"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Repair note remains practical and non-clinical.",
        tier="T4",
    ),
    Scenario(
        id="i1.rupture_repair.repair_followup_cadence",
        name="Schedule a quiet check-in after an approved repair",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "After I send the approved apology to Priya, remind me in three "
            "days to check whether she replied. Do not nudge her directly."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASKS",
                kwargs={
                    "action": "create",
                    "kind": "followup",
                    "subjectKind": "relationship",
                    "subjectId": "rel-i1-priya",
                    "trigger": {"kind": "once", "offset": "P3D"},
                    "completionCheck": {"kind": "subject_updated"},
                },
            )
        ],
        required_outputs=["three days", "check", "not nudge"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Loop closure is a structural owner-facing follow-up.",
        tier="T3",
    ),
    Scenario(
        id="i1.rupture_repair.private_context_minimized",
        name="Minimize private context in a repair draft",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Draft a repair note to Jordan about the tense pickup swap. Do not "
            "mention the private custody-history note or anything our kid said."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "subaction": "draft_reply",
                    "recipient": "Jordan Lee",
                    "requiresConfirmation": True,
                    "privacyConstraints": ["omit_child_statement", "omit_custody_history"],
                },
            )
        ],
        required_outputs=["draft", "pickup", "approval"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Correct, keep it to the pickup swap and leave the child out of it.",
            applies_when="agent asks whether sensitive family context can be included",
        ),
        world_seed=2026,
        max_turns=6,
        description="Repair draft uses only shareable logistics context.",
        tier="T3",
    ),
    Scenario(
        id="i1.rupture_repair.rewrite_same_themes",
        name="Rewrite a repair note without adding new grievances",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Rewrite my note to Zane to be warmer, but keep the same facts: I "
            "was short about the missed coffee plan and want to reset."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "subaction": "draft_reply",
                    "recipient": "Zane Turner",
                    "requiresConfirmation": True,
                    "constraint": "same-themes-only",
                },
            )
        ],
        required_outputs=["warmer", "missed coffee", "reset"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Rewrite improves tone without fabricating extra conflict.",
        tier="T2",
    ),
]
