"""Contacts-domain scenarios.

Backed by 200 contacts seeded into ``data/snapshots/medium_seed_2026.json``.
The medium snapshot contains multiple Carters (family + friend +
acquaintance) for partial-name disambiguation tests, plus six explicit
``relationship == 'family'`` contacts.

Contact ops route through the ``ENTITY`` umbrella action with a
``subaction`` discriminator (matching the planner's surface).
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
)

CONTACTS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="contacts.add_new_freelance_collaborator",
        name="Add a new freelance collaborator",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Add a new contact: Priya Singh, freelance illustrator, "
            "priya@studiosingh.example, +14155550199. Tag her as work."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "add",
                    "name": "Priya Singh",
                    "email": "priya@studiosingh.example",
                    "phone": "+14155550199",
                    "channel": "email",
                    "handle": "priya@studiosingh.example",
                    "notes": "freelance illustrator",
                },
            ),
        ],
        required_outputs=["Priya"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Email is the main channel; tag her as a work contact.",
            applies_when="agent asks about preferred channel or relationship tag",
        ),
        world_seed=2026,
        max_turns=5,
        description="Single contact creation. Tests the add subaction.",
    ),
    Scenario(
        id="contacts.update_phone_for_caleb_nguyen",
        name="Update Caleb Nguyen's phone number",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Caleb Nguyen got a new phone — update his contact (contact_00001) "
            "to +14155550247."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "set_identity",
                    "entityId": "contact_00001",
                    "platform": "phone",
                    "handle": "+14155550247",
                    "displayName": "Caleb Nguyen",
                    "evidence": "owner provided new number directly",
                },
            ),
        ],
        required_outputs=["Caleb"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Targeted identity update on a real seeded contact.",
    ),
    Scenario(
        id="contacts.find_contact_by_partial_name_carter",
        name="Find contact by partial name 'Carter'",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction=(
            "Look up everyone in my contacts whose last name is Carter. I "
            "can't remember which one helped with the move."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "list",
                    "intent": "list contacts whose family name is Carter",
                    "name": "Carter",
                },
            ),
        ],
        required_outputs=["Carter"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just everyone matching — I'll pick from the list.",
            applies_when="agent asks to narrow further (relationship, channel)",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "Disambiguation test: snapshot has 8 Carters across "
            "family/friend/acquaintance."
        ),
    ),
    Scenario(
        id="contacts.list_family_contacts",
        name="List family contacts",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="who's in my contacts tagged family?",
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "list",
                    "intent": "list contacts where relationship is family",
                },
            ),
        ],
        required_outputs=["family"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only relationship filter; ~6 family rows in seed.",
    ),
    Scenario(
        id="contacts.log_interaction_with_julia_mitchell",
        name="Log interaction with Julia Mitchell",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "Note that I had a 30-minute strategy call with Julia Mitchell "
            "(contact_00002) today; she's open to the Q3 partnership."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "entityId": "contact_00002",
                    "name": "Julia Mitchell",
                    "notes": (
                        "30-minute strategy call; open to the Q3 partnership"
                    ),
                },
            ),
        ],
        required_outputs=["Julia"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Interaction log capture — additive, not destructive.",
    ),
]
