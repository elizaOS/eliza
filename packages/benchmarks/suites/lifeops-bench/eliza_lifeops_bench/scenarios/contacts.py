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
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
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
    ),    Scenario(
        id='contacts.add_new_vpn_provider',
        name='Add VPN provider contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Add a new contact for my VPN provider: SecureNet, email support@securenet.example, phone +14155552345. Tag it as work.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'SecureNet',
                    'email': 'support@securenet.example',
                    'phone': '+14155552345',
                    'channel': 'email',
                    'handle': 'support@securenet.example',
                    'notes': 'VPN provider',
                    'intent': 'add work contact',
                },
            ),
        ],
        required_outputs=['SecureNet', 'VPN'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Work tag is fine; I'll add it as a work contact.",
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Simple addition of a new work contact for a VPN service.',
    ),
    Scenario(
        id='contacts.update_email_for_contact_00003',
        name='Update email for contact 00003',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Contact_00003 just changed their email to dev_03@example.test. Please update the record.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'set_identity',
                    'entityId': 'contact_00003',
                    'platform': 'email',
                    'handle': 'dev_03@example.test',
                    'displayName': 'Contact 00003',
                    'evidence': 'user provided new email',
                },
            ),
        ],
        required_outputs=['dev_03@example.test'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates the email address of an existing contact.',
    ),
    Scenario(
        id='contacts.list_all_work_contacts',
        name='List all contacts tagged work',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Show me every contact I have marked as work.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts with work tag',
                },
            ),
        ],
        required_outputs=['work'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read-only query for all work-tagged contacts.',
    ),
    Scenario(
        id='contacts.find_by_phone_prefix',
        name='Find contacts with phone prefix +1415',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Find any contacts whose phone starts with +1415.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts where phone starts with +1415',
                },
            ),
        ],
        required_outputs=['+1415'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Sure, I'll look for that prefix.",
            applies_when='agent asks which prefix to use',
        ),
        world_seed=2026,
        max_turns=4,
        description='Search contacts by phone number prefix.',
    ),
    Scenario(
        id='contacts.log_meeting_with_john_doe',
        name='Log meeting with John Doe',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Log that I had a 45‑minute strategy meeting with John Doe (contact_00001) on 2026‑05‑09; discuss Q2 planning.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'log_interaction',
                    'entityId': 'contact_00001',
                    'name': 'John Doe',
                    'notes': '45-minute strategy meeting on 2026‑05‑09; Q2 planning',
                },
            ),
        ],
        required_outputs=['John Doe', 'strategy'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Adds a log entry for a past meeting.',
    ),
    Scenario(
        id='contacts.add_family_member_mia',
        name='Add family member Mia',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Add my sister Mia Reed to my contacts. Email mía.reed@example.test, phone +14155559876, tag as family.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Mia Reed',
                    'email': 'mía.reed@example.test',
                    'phone': '+14155559876',
                    'channel': 'email',
                    'handle': 'mía.reed@example.test',
                    'notes': 'sister',
                    'intent': 'add family contact',
                },
            ),
        ],
        required_outputs=['Mia', 'family'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Family tag noted; I'll add her as a sibling.",
            applies_when='agent asks about relationship type',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new family contact.',
    ),
    Scenario(
        id='contacts.add_social_media_contact',
        name='Add Instagram contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Add a new contact for my Instagram collaborator, @creativebuzz, email creative@buzz.example.test. Tag as work.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Creative Buzz',
                    'email': 'creative@buzz.example.test',
                    'channel': 'email',
                    'handle': 'creative@buzz.example.test',
                    'notes': 'Instagram collaborator @creativebuzz',
                    'intent': 'add work contact',
                },
            ),
        ],
        required_outputs=['Creative Buzz', 'Instagram'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work tag is fine; I’ll add the Instagram collaborator.',
            applies_when='agent asks which tag to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Adds a new contact with social media reference.',
    ),
    Scenario(
        id='contacts.list_contacts_without_email',
        name='List contacts lacking an email address',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction="Who in my contacts doesn't have an email address?",
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts missing email',
                },
            ),
        ],
        required_outputs=['no email'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read-only query for contacts missing email info.',
    ),
    Scenario(
        id='contacts.find_by_company_name',
        name='Find contacts at Acme Corp',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Show me any contacts that work at Acme Corp.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts where company is Acme Corp',
                },
            ),
        ],
        required_outputs=['Acme'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='I’ll filter by Acme Corp.',
            applies_when='agent asks which company to filter',
        ),
        world_seed=2026,
        max_turns=4,
        description='Search contacts by employer name.',
    ),
    Scenario(
        id='contacts.add_new_mentor',
        name='Add mentor contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Add a mentor, Dr. Lena Ortiz, email lena.oritz@example.test, phone +14155553456, tag as mentor.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Dr. Lena Ortiz',
                    'email': 'lena.oritz@example.test',
                    'phone': '+14155553456',
                    'channel': 'email',
                    'handle': 'lena.oritz@example.test',
                    'notes': 'mentor',
                    'intent': 'add mentor contact',
                },
            ),
        ],
        required_outputs=['Lena', 'mentor'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Mentor tag noted; I’ll add Dr. Ortiz.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new mentor contact.',
    ),
    Scenario(
        id='contacts.update_phone_for_contact_00004',
        name='Update phone for contact 00004',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Contact_00004's phone changed to +14155559999. Update it.",
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'set_identity',
                    'entityId': 'contact_00004',
                    'platform': 'phone',
                    'handle': '+14155559999',
                    'displayName': 'Contact 00004',
                    'evidence': 'user supplied new number',
                },
            ),
        ],
        required_outputs=['+14155559999'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates phone number for an existing contact.',
    ),
    Scenario(
        id='contacts.list_family_without_phone',
        name='List family contacts missing phone',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Which family contacts don’t have a phone number listed?',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list family contacts missing phone',
                },
            ),
        ],
        required_outputs=['family', 'no phone'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Filters family contacts by missing phone info.',
    ),
    Scenario(
        id='contacts.add_new_client_alpha',
        name='Add new client Alpha Co.',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Add a new business contact for client Alpha Co., email contact@alpha.example.test, phone +14155551111, tag as client.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Alpha Co.',
                    'email': 'contact@alpha.example.test',
                    'phone': '+14155551111',
                    'channel': 'email',
                    'handle': 'contact@alpha.example.test',
                    'notes': 'client',
                    'intent': 'add client contact',
                },
            ),
        ],
        required_outputs=['Alpha', 'client'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Client tag confirmed; I’ll add the new business contact.',
            applies_when='agent asks which tag to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Adds a new business client contact.',
    ),
    Scenario(
        id='contacts.log_call_with_emily',
        name='Log phone call with Emily',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Log that I called Emily Chen (contact_00005) for 20 minutes today about the upcoming product launch.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'log_interaction',
                    'entityId': 'contact_00005',
                    'name': 'Emily Chen',
                    'notes': '20-minute call today about product launch',
                },
            ),
        ],
        required_outputs=['Emily', 'product launch'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Adds a log entry for a recent phone call.',
    ),
    Scenario(
        id='contacts.find_contact_by_partial_email',
        name='Find contacts with @example.test email',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Find any contacts whose email ends with @example.test.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts where email ends with @example.test',
                },
            ),
        ],
        required_outputs=['@example.test'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Searches contacts by email domain.',
    ),
    Scenario(
        id='contacts.add_new_volunteer',
        name='Add volunteer contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Add volunteer Maya Patel, email maya.vol@example.test, phone +14155552222, tag as volunteer.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Maya Patel',
                    'email': 'maya.vol@example.test',
                    'phone': '+14155552222',
                    'channel': 'email',
                    'handle': 'maya.vol@example.test',
                    'notes': 'volunteer',
                    'intent': 'add volunteer contact',
                },
            ),
        ],
        required_outputs=['Maya', 'volunteer'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Volunteer tag noted; I’ll add Maya as a volunteer.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new volunteer contact.',
    ),
    Scenario(
        id='contacts.list_contacts_by_tag_friend',
        name='List contacts tagged friend',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Show me all contacts I have tagged as friend.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts with friend tag',
                },
            ),
        ],
        required_outputs=['friend'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Lists contacts with a specific tag.',
    ),
    Scenario(
        id='contacts.add_new_supplier',
        name='Add new supplier contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Add a supplier contact: Global Supplies Ltd., email sales@globalsupplies.example.test, phone +14155558888, tag as supplier.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Global Supplies Ltd.',
                    'email': 'sales@globalsupplies.example.test',
                    'phone': '+14155558888',
                    'channel': 'email',
                    'handle': 'sales@globalsupplies.example.test',
                    'notes': 'supplier',
                    'intent': 'add supplier contact',
                },
            ),
        ],
        required_outputs=['Global Supplies', 'supplier'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Supplier tag confirmed; I’ll add the new supplier.',
            applies_when='agent asks which tag to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Adds a new business supplier contact.',
    ),
    Scenario(
        id='contacts.update_company_for_contact_00007',
        name='Update company for contact 00007',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Contact_00007 now works at Beta Industries. Update the company field.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'set_identity',
                    'entityId': 'contact_00007',
                    'platform': 'company',
                    'handle': 'Beta Industries',
                    'displayName': 'Contact 00007',
                    'evidence': 'user supplied new employer',
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['Beta Industries'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, I’ll update the company to Beta Industries.',
            applies_when='agent asks for confirmation before changing company',
        ),
        world_seed=2026,
        max_turns=5,
        description='Updates employer information for a contact.',
    ),
    Scenario(
        id='contacts.log_meeting_with_sarah',
        name='Log meeting with Sarah',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Log a 30‑minute counseling session with Sarah Lee (contact_00008) today about stress management.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'log_interaction',
                    'entityId': 'contact_00008',
                    'name': 'Sarah Lee',
                    'notes': '30-minute counseling session today about stress management',
                },
            ),
        ],
        required_outputs=['Sarah', 'stress'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Adds a log entry for a personal counseling session.',
    ),
    Scenario(
        id='contacts.add_new_event_planner',
        name='Add event planner contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Add contact for event planner: EventCo, email planner@eventco.example.test, phone +14155557777, tag as work.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'EventCo',
                    'email': 'planner@eventco.example.test',
                    'phone': '+14155557777',
                    'channel': 'email',
                    'handle': 'planner@eventco.example.test',
                    'notes': 'event planner',
                    'intent': 'add work contact',
                },
            ),
        ],
        required_outputs=['EventCo', 'planner'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work tag noted; I’ll add the event planner.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new work contact for an event planner.',
    ),
    Scenario(
        id='contacts.list_contacts_without_notes',
        name='List contacts missing notes',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='Which contacts have no notes field filled in?',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts where notes are empty',
                },
            ),
        ],
        required_outputs=['no notes'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read‑only query for contacts lacking notes.',
    ),
    Scenario(
        id='contacts.add_new_legal_advisor',
        name='Add legal advisor contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Add legal advisor: Laura Gomez, email laura.gomez@example.test, phone +14155554444, tag as advisor.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Laura Gomez',
                    'email': 'laura.gomez@example.test',
                    'phone': '+14155554444',
                    'channel': 'email',
                    'handle': 'laura.gomez@example.test',
                    'notes': 'legal advisor',
                    'intent': 'add advisor contact',
                },
            ),
        ],
        required_outputs=['Laura', 'advisor'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Advisor tag confirmed; I’ll add Laura as my legal advisor.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Adds a new legal advisor contact.',
    ),
    Scenario(
        id='contacts.update_phone_for_contact_00009',
        name='Update phone for contact 00009',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Contact_00009's phone is now +14155556666. Please update.",
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'set_identity',
                    'entityId': 'contact_00009',
                    'platform': 'phone',
                    'handle': '+14155556666',
                    'displayName': 'Contact 00009',
                    'evidence': 'user supplied new phone',
                },
            ),
        ],
        required_outputs=['+14155556666'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates the phone number for an existing contact.',
    ),
    Scenario(
        id='contacts.log_meeting_with_mark',
        name='Log meeting with Mark',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Log a 1‑hour meeting with Mark Patel (contact_00010) on 2026‑05‑08 about quarterly budget.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'log_interaction',
                    'entityId': 'contact_00010',
                    'name': 'Mark Patel',
                    'notes': '1-hour meeting on 2026‑05‑08 about quarterly budget',
                },
            ),
        ],
        required_outputs=['Mark', 'budget'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Adds a log entry for a past budgeting meeting.',
    ),
    Scenario(
        id='contacts.list_contacts_by_tag_supplier',
        name='List supplier contacts',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me a list of all contacts tagged as supplier.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'list',
                    'intent': 'list contacts with supplier tag',
                },
            ),
        ],
        required_outputs=['supplier'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read‑only query for supplier‑tagged contacts.',
    ),
    Scenario(
        id='contacts.add_new_academic_collaborator',
        name='Add academic collaborator',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Add Dr. Ethan Wu, email ethan.wu@example.test, phone +14155557788, tag as academic.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Dr. Ethan Wu',
                    'email': 'ethan.wu@example.test',
                    'phone': '+14155557788',
                    'channel': 'email',
                    'handle': 'ethan.wu@example.test',
                    'notes': 'academic collaborator',
                    'intent': 'add academic contact',
                },
            ),
        ],
        required_outputs=['Ethan', 'academic'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Academic tag noted; I’ll add Dr. Wu.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new academic collaborator contact.',
    ),
    Scenario(
        id='contacts.log_meeting_with_anna',
        name='Log meeting with Anna',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='Log that I met with Anna Rivera (contact_00012) for 15 minutes yesterday about garden supplies.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'log_interaction',
                    'entityId': 'contact_00012',
                    'name': 'Anna Rivera',
                    'notes': '15-minute meeting yesterday about garden supplies',
                },
            ),
        ],
        required_outputs=['Anna', 'garden'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Adds a log entry for a short meeting.',
    ),
    Scenario(
        id='contacts.add_new_conference_speaker',
        name='Add conference speaker contact',
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Add speaker: Prof. Maya Liu, email maya.liu@example.test, phone +14155554321, tag as speaker.',
        ground_truth_actions=[
            Action(
                name='ENTITY',
                kwargs={
                    'subaction': 'add',
                    'name': 'Prof. Maya Liu',
                    'email': 'maya.liu@example.test',
                    'phone': '+14155554321',
                    'channel': 'email',
                    'handle': 'maya.liu@example.test',
                    'notes': 'conference speaker',
                    'intent': 'add speaker contact',
                },
            ),
        ],
        required_outputs=['Maya Liu', 'speaker'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Speaker tag confirmed; I’ll add Prof. Liu.',
            applies_when='agent asks which tag to apply',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a new contact for a conference speaker.',
    ),

]
