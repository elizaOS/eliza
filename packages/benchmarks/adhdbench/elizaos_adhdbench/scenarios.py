"""All 45 benchmark scenarios for ADHDBench.

Level 0: Single-turn action dispatch (20 scenarios)
Level 1: Multi-turn context tracking (15 scenarios)
Level 2: Complex task execution (10 scenarios)
"""

from __future__ import annotations

from elizaos_adhdbench.types import (
    ExpectedOutcome,
    OutcomeType,
    Scenario,
    ScenarioLevel,
    Turn,
)

_o = ExpectedOutcome
_OT = OutcomeType
L0 = ScenarioLevel.ACTION_DISPATCH
L1 = ScenarioLevel.CONTEXT_TRACKING
L2 = ScenarioLevel.COMPLEX_EXECUTION


def _action(name: str | list[str], weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.ACTION_MATCH, value=name, weight=weight)


def _no_action(name: str | list[str], weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.ACTION_NOT_MATCH, value=name, weight=weight)


def _contains(text: str, weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.TEXT_CONTAINS, value=text, weight=weight)


def _not_contains(text: str, weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.TEXT_NOT_CONTAINS, value=text, weight=weight)


def _param(params: dict[str, str], weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.PARAM_MATCH, value=params, weight=weight)


def _recall(text: str, weight: float = 1.0) -> ExpectedOutcome:
    return _o(outcome_type=_OT.MEMORY_RECALLED, value=text, weight=weight)


def _providers(names: list[str], weight: float = 0.5) -> ExpectedOutcome:
    return _o(outcome_type=_OT.PROVIDERS_REQUESTED, value=names, weight=weight)


# ===================================================================
# LEVEL 0 -- Single-Turn Action Dispatch (20 scenarios)
# ===================================================================

L0_SCENARIOS: list[Scenario] = [
    Scenario(
        id="L0-001", name="Simple time question",
        description="Agent should REPLY to a time question, not invoke STATUS or a distractor",
        level=L0, tags=("core", "reply"), distractor_action_count=20,
        turns=(Turn(role="user", text="What time is it right now?",
            expected_outcomes=(_action("REPLY"), _no_action("STATUS"))),),
    ),
    Scenario(
        id="L0-002", name="Send message to contact",
        description="Agent should SEND_MESSAGE with correct target, not SEND_TOKENS",
        level=L0, tags=("core", "send_message"), distractor_action_count=30,
        turns=(Turn(role="user", text="Send a message to Alice saying I will be late to the meeting",
            expected_outcomes=(_action("SEND_MESSAGE"), _no_action("SEND_TOKENS"), _no_action("REPLY_TWEET"))),),
    ),
    Scenario(
        id="L0-003", name="Store preference via conversation",
        description="Agent should REPLY acknowledging the preference, not UPDATE_CONTACT",
        level=L0, tags=("core", "reply", "memory"), distractor_action_count=20,
        turns=(Turn(role="user", text="Remember that my favourite color is blue",
            expected_outcomes=(_action("REPLY"), _no_action("UPDATE_CONTACT"), _no_action("UPDATE_CONTACT_INFO"), _contains("blue", weight=0.5))),),
    ),
    Scenario(
        id="L0-004", name="Mute room",
        description="Agent should MUTE_ROOM, not SILENCE_USER or UNFOLLOW_ROOM",
        level=L0, tags=("core", "room_mgmt"), distractor_action_count=30,
        turns=(Turn(role="user", text="Mute this conversation, it is too noisy",
            expected_outcomes=(_action("MUTE_ROOM"), _no_action("SILENCE_USER"), _no_action("UNFOLLOW_ROOM"))),),
    ),
    Scenario(
        id="L0-005", name="Plan creation request",
        description="Agent should CREATE_PLAN or REPLY with structured plan",
        level=L0, tags=("core", "planning"), requires_advanced_planning=True, distractor_action_count=25,
        turns=(Turn(role="user", text="Create a detailed plan to migrate our database to PostgreSQL",
            expected_outcomes=(_action(["CREATE_PLAN", "REPLY"]), _no_action("CREATE_TASK"))),),
    ),
    Scenario(
        id="L0-006", name="Ignore meta-communication",
        description="Agent should handle a message about ignoring",
        level=L0, tags=("core", "ignore"), distractor_action_count=20,
        turns=(Turn(role="user", text="Just ignore that last message, it was meant for someone else",
            expected_outcomes=(_action(["IGNORE", "NONE", "REPLY"]), _no_action("DELETE_MESSAGE"))),),
    ),
    Scenario(
        id="L0-007", name="Image generation",
        description="Agent should GENERATE_IMAGE, not DESIGN_LOGO or EDIT_IMAGE",
        level=L0, tags=("core", "image"), distractor_action_count=30,
        turns=(Turn(role="user", text="Can you generate a picture of a cat wearing a top hat?",
            expected_outcomes=(_action("GENERATE_IMAGE"), _no_action("DESIGN_LOGO"), _no_action("EDIT_IMAGE"))),),
    ),
    Scenario(
        id="L0-008", name="Follow room",
        description="Agent should FOLLOW_ROOM, not FOLLOW_USER",
        level=L0, tags=("core", "room_mgmt"), distractor_action_count=25,
        turns=(Turn(role="user", text="Follow the announcements channel so we do not miss anything",
            expected_outcomes=(_action("FOLLOW_ROOM"), _no_action("FOLLOW_USER"))),),
    ),
    Scenario(
        id="L0-009", name="Search contacts",
        description="Agent should SEARCH_CONTACTS, not SEARCH_DOCS or RUN_QUERY",
        level=L0, tags=("core", "contacts"), distractor_action_count=30,
        turns=(Turn(role="user", text="Find all the people named Chen in our contacts",
            expected_outcomes=(_action("SEARCH_CONTACTS"), _no_action("SEARCH_DOCS"), _no_action("RUN_QUERY"))),),
    ),
    Scenario(
        id="L0-010", name="Status request",
        description="Agent should STATUS or REPLY, not GET_METRICS",
        level=L0, tags=("core", "status"), distractor_action_count=25,
        turns=(Turn(role="user", text="Can you give me a status update on everything?",
            expected_outcomes=(_action(["STATUS", "REPLY"]), _no_action("GET_METRICS"), _no_action("GENERATE_REPORT"))),),
    ),
    Scenario(
        id="L0-011", name="Update role",
        description="Agent should UPDATE_ROLE with correct params",
        level=L0, tags=("core", "roles"), distractor_action_count=25,
        turns=(Turn(role="user", text="Make Sarah an admin for the project channel",
            expected_outcomes=(_action("UPDATE_ROLE"), _no_action("BAN_USER"))),),
    ),
    Scenario(
        id="L0-012", name="Schedule follow-up",
        description="Agent should SCHEDULE_FOLLOW_UP, not SET_REMINDER",
        level=L0, tags=("core", "scheduling"), distractor_action_count=30,
        turns=(Turn(role="user", text="Remind me to call the dentist tomorrow at 10am",
            expected_outcomes=(_action("SCHEDULE_FOLLOW_UP"), _no_action("SET_REMINDER"), _no_action("ADD_CALENDAR_EVENT"))),),
    ),
    Scenario(
        id="L0-013", name="Unfollow room",
        description="Agent should UNFOLLOW_ROOM, not MUTE_ROOM",
        level=L0, tags=("core", "room_mgmt"), distractor_action_count=25,
        turns=(Turn(role="user", text="Stop following the random channel, I am getting too many notifications",
            expected_outcomes=(_action("UNFOLLOW_ROOM"), _no_action("MUTE_ROOM"))),),
    ),
    Scenario(
        id="L0-014", name="Add contact",
        description="Agent should ADD_CONTACT, not INVITE_USER",
        level=L0, tags=("core", "contacts"), distractor_action_count=25,
        turns=(Turn(role="user", text="Add my new colleague Bob (bob@acme.com) to my contacts",
            expected_outcomes=(_action("ADD_CONTACT"), _no_action("INVITE_USER"))),),
    ),
    Scenario(
        id="L0-015", name="Remove contact",
        description="Agent should REMOVE_CONTACT, not UPDATE_CONTACT",
        level=L0, tags=("core", "contacts"), distractor_action_count=20,
        turns=(Turn(role="user", text="Remove the old contact info for John Doe entirely",
            expected_outcomes=(_action("REMOVE_CONTACT"), _no_action("UPDATE_CONTACT"), _no_action("UPDATE_CONTACT_INFO"))),),
    ),
    Scenario(
        id="L0-016", name="Update settings",
        description="Agent should UPDATE_SETTINGS, not UPDATE_CONTACT",
        level=L0, tags=("core", "settings"), distractor_action_count=25,
        turns=(Turn(role="user", text="Change my notification preferences to email only",
            expected_outcomes=(_action("UPDATE_SETTINGS"), _no_action("UPDATE_CONTACT"))),),
    ),
    Scenario(
        id="L0-017", name="Unmute room",
        description="Agent should UNMUTE_ROOM, not UNFOLLOW_ROOM",
        level=L0, tags=("core", "room_mgmt"), distractor_action_count=20,
        turns=(Turn(role="user", text="Unmute the general channel, the important discussion is happening",
            expected_outcomes=(_action("UNMUTE_ROOM"), _no_action("UNFOLLOW_ROOM"))),),
    ),
    Scenario(
        id="L0-018", name="Reset session",
        description="Agent should RESET_SESSION, not COMPACT_SESSION",
        level=L0, tags=("core", "session"), distractor_action_count=20,
        turns=(Turn(role="user", text="Let us start fresh, clear everything from this conversation",
            expected_outcomes=(_action("RESET_SESSION"), _no_action("COMPACT_SESSION"))),),
    ),
    Scenario(
        id="L0-019", name="Update contact info",
        description="Agent should UPDATE_CONTACT_INFO, not REMOVE_CONTACT",
        level=L0, tags=("core", "contacts"), distractor_action_count=20,
        turns=(Turn(role="user", text="Update Alice phone number to 555-0199",
            expected_outcomes=(_action(["UPDATE_CONTACT_INFO", "UPDATE_CONTACT"]), _no_action("REMOVE_CONTACT"))),),
    ),
    Scenario(
        id="L0-020", name="Simple greeting",
        description="Agent should REPLY to a greeting, resisting many other actions",
        level=L0, tags=("core", "reply"), distractor_action_count=50,
        turns=(Turn(role="user", text="Hey, how are you doing today?",
            expected_outcomes=(_action("REPLY"), _no_action("STATUS"), _no_action("GET_METRICS"))),),
    ),
]


# ===================================================================
# LEVEL 1 -- Multi-Turn Context Tracking (15 scenarios)
# ===================================================================

L1_SCENARIOS: list[Scenario] = [
    Scenario(
        id="L1-001", name="Rapid topic switch",
        description="Agent must track two interleaved topics across 6 turns",
        level=L1, tags=("context", "topic_switch"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="I am thinking about getting a dog. What breed would you recommend for someone active?"),
            Turn(role="user", text="Actually, what is the weather like today?",
                expected_outcomes=(_action("REPLY"),)),
            Turn(role="user", text="Going back to the dog thing - I live in a small apartment though",
                expected_outcomes=(_action("REPLY"), _contains("apartment", weight=0.5))),
            Turn(role="user", text="Oh and remind me about the vet appointment Friday at 3pm",
                expected_outcomes=(_action("SCHEDULE_FOLLOW_UP"),)),
            Turn(role="user", text="So based on the apartment thing, what breed do you recommend?",
                expected_outcomes=(_action("REPLY"), _contains("apartment", weight=0.8))),
            Turn(role="user", text="What was that reminder I just set?",
                expected_outcomes=(_action("REPLY"), _contains("vet", weight=0.5), _contains("Friday", weight=0.5))),
        ),
    ),
    Scenario(
        id="L1-002", name="Buried instruction",
        description="Agent must recall a conditional instruction after 9 turns of distraction",
        level=L1, tags=("context", "buried_instruction"), distractor_action_count=20,
        turns=(
            Turn(role="user", text="When I say the word pineapple, I want you to add Bob (bob@test.com) to my contacts. Understood?"),
            Turn(role="user", text="What is your favourite movie genre?"),
            Turn(role="user", text="I had pasta for lunch, it was pretty good."),
            Turn(role="user", text="Do you think electric cars are worth it?"),
            Turn(role="user", text="I need to buy groceries this weekend."),
            Turn(role="user", text="Have you heard of the band Radiohead?"),
            Turn(role="user", text="My cat knocked over my coffee this morning."),
            Turn(role="user", text="What is the square root of 144?"),
            Turn(role="user", text="I should really clean my apartment."),
            Turn(role="user", text="The sunset yesterday was beautiful."),
            Turn(role="user", text="pineapple",
                expected_outcomes=(_action("ADD_CONTACT"),)),
            Turn(role="user", text="Did you do the thing I asked about earlier?",
                expected_outcomes=(_action("REPLY"), _contains("Bob", weight=0.7), _contains("contact", weight=0.5))),
        ),
    ),
    Scenario(
        id="L1-003", name="Entity tracking across turns",
        description="Agent must track 5 people introduced across interleaved turns",
        level=L1, tags=("context", "entity_tracking"), distractor_action_count=10,
        turns=(
            Turn(role="user", text="Let me tell you about my team. Alice is our lead engineer."),
            Turn(role="user", text="Oh, I also need to mention Bob - he is the designer."),
            Turn(role="user", text="By the way, did you see the game last night?"),
            Turn(role="user", text="Carol is our project manager. She is really organised."),
            Turn(role="user", text="Dave handles QA. He is very thorough."),
            Turn(role="user", text="I forgot to mention Eve - she is the new intern."),
            Turn(role="user", text="Who is the designer on my team?",
                expected_outcomes=(_action("REPLY"), _contains("Bob"))),
            Turn(role="user", text="What does Carol do?",
                expected_outcomes=(_action("REPLY"), _contains("project manager", weight=0.8))),
            Turn(role="user", text="And who is the newest team member?",
                expected_outcomes=(_action("REPLY"), _contains("Eve"))),
        ),
    ),
    Scenario(
        id="L1-004", name="Contradictory updates",
        description="Agent must use the latest value when facts are updated",
        level=L1, tags=("context", "contradiction"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="My email is alice@old.com"),
            Turn(role="user", text="How is your day going?"),
            Turn(role="user", text="Actually, I changed my email to alice@new.com"),
            Turn(role="user", text="Can you tell me a joke?"),
            Turn(role="user", text="Can you update my contact info with my current email?",
                expected_outcomes=(_action(["UPDATE_CONTACT_INFO", "UPDATE_CONTACT", "REPLY"]),
                    _contains("alice@new.com", weight=1.0), _not_contains("alice@old.com", weight=0.8))),
        ),
    ),
    Scenario(
        id="L1-005", name="Cross-session memory",
        description="Agent must recall facts from session A in session B",
        level=L1, tags=("context", "memory", "cross_session"), requires_advanced_memory=True, distractor_action_count=10,
        turns=(
            Turn(role="user", text="I am allergic to peanuts, that is really important to remember"),
            Turn(role="user", text="Also, my birthday is March 15th"),
            Turn(role="user", text="Thanks for noting that down!"),
            Turn(role="user", text="Hey, I am back! Do you remember anything about me?",
                new_session=True, delay_seconds=1.0,
                expected_outcomes=(_action("REPLY"), _recall("peanut", weight=1.0))),
            Turn(role="user", text="What foods should you never recommend to me?",
                expected_outcomes=(_action("REPLY"), _recall("peanut", weight=1.0))),
        ),
    ),
    Scenario(
        id="L1-006", name="Distraction resistance",
        description="Agent must recall a multi-step instruction after 12 distractor turns",
        level=L1, tags=("context", "distraction_resistance"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="I need to organise a team dinner. The steps are: 1) find a restaurant, 2) send invitations, 3) set a reminder for the day before. Got it?"),
            Turn(role="user", text="What is 2 plus 2?"),
            Turn(role="user", text="Tell me a joke."),
            Turn(role="user", text="What is the capital of France?"),
            Turn(role="user", text="Do you like pizza?"),
            Turn(role="user", text="What colour is the sky?"),
            Turn(role="user", text="How many days in a year?"),
            Turn(role="user", text="Who painted the Mona Lisa?"),
            Turn(role="user", text="What is the speed of light?"),
            Turn(role="user", text="Name a prime number."),
            Turn(role="user", text="What year did WW2 end?"),
            Turn(role="user", text="Is water wet?"),
            Turn(role="user", text="Can you whistle?"),
            Turn(role="user", text="OK back to the dinner plan - what was step 2 again?",
                expected_outcomes=(_action("REPLY"), _contains("invitation", weight=0.8))),
            Turn(role="user", text="Great, now do step 2 - send a message to the team about the dinner",
                expected_outcomes=(_action("SEND_MESSAGE"),)),
        ),
    ),
    Scenario(
        id="L1-007", name="Numerical recall",
        description="Agent must recall specific numbers scattered across conversation",
        level=L1, tags=("context", "numerical_recall"), distractor_action_count=10,
        turns=(
            Turn(role="user", text="Project Alpha costs $50,000 total."),
            Turn(role="user", text="We have 12 team members working on it."),
            Turn(role="user", text="What did you do this weekend?"),
            Turn(role="user", text="The deadline is in 45 days."),
            Turn(role="user", text="Budget remaining is $23,000."),
            Turn(role="user", text="How is the traffic today?"),
            Turn(role="user", text="We have completed 3 of the 7 milestones."),
            Turn(role="user", text="What is our remaining budget and how many milestones are done?",
                expected_outcomes=(_action("REPLY"), _contains("23", weight=1.0), _contains("3", weight=0.8))),
        ),
    ),
    Scenario(
        id="L1-008", name="Implicit reference resolution",
        description="Agent must resolve them to the marketing team",
        level=L1, tags=("context", "reference_resolution"), distractor_action_count=20,
        turns=(
            Turn(role="user", text="I just had a meeting with the marketing team about the Q3 campaign."),
            Turn(role="user", text="They want us to increase the budget by 20 percent."),
            Turn(role="user", text="Can you send them a message saying we will review it?",
                expected_outcomes=(_action("SEND_MESSAGE"),)),
        ),
    ),
    Scenario(
        id="L1-009", name="Long conversation with compaction",
        description="Agent must recall early content after 20+ messages",
        level=L1, tags=("context", "long_conversation", "compaction"), requires_advanced_memory=True, distractor_action_count=10,
        turns=(
            Turn(role="user", text="The project codename is Phoenix and the launch date is April 1st."),
            Turn(role="user", text="What programming languages do you know?"),
            Turn(role="user", text="I like hiking in the mountains."),
            Turn(role="user", text="The quarterly targets are aggressive this year."),
            Turn(role="user", text="My dog name is Max."),
            Turn(role="user", text="Have you ever been to Japan?"),
            Turn(role="user", text="I think AI is going to change education."),
            Turn(role="user", text="The new office has a great view."),
            Turn(role="user", text="I started learning guitar last month."),
            Turn(role="user", text="Supply chain issues are improving."),
            Turn(role="user", text="My favourite season is autumn."),
            Turn(role="user", text="The company retreat is in June."),
            Turn(role="user", text="I need a new laptop soon."),
            Turn(role="user", text="Do you think remote work is here to stay?"),
            Turn(role="user", text="The marketing budget got approved."),
            Turn(role="user", text="I am training for a half marathon."),
            Turn(role="user", text="Our biggest competitor just raised funding."),
            Turn(role="user", text="I love Thai food."),
            Turn(role="user", text="The new hire starts on Monday."),
            Turn(role="user", text="Cloud costs have been increasing."),
            Turn(role="user", text="What was the project codename I mentioned at the start?",
                expected_outcomes=(_action("REPLY"), _contains("Phoenix", weight=1.0))),
            Turn(role="user", text="And what is the launch date?",
                expected_outcomes=(_action("REPLY"), _contains("April", weight=1.0))),
        ),
    ),
    Scenario(
        id="L1-010", name="Action momentum",
        description="After 3 SEND_MESSAGE actions, ambiguous message should favour SEND_MESSAGE",
        level=L1, tags=("context", "momentum"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="Send a message to Alice: Meeting at 3pm"),
            Turn(role="user", text="Also send one to Bob: Please review the doc"),
            Turn(role="user", text="And send Carol: Budget approved"),
            Turn(role="user", text="Also tell Dave about the meeting",
                expected_outcomes=(_action("SEND_MESSAGE"),)),
        ),
    ),
    Scenario(
        id="L1-011", name="Provider necessity",
        description="Agent should request appropriate providers for different questions",
        level=L1, tags=("context", "provider_selection"), distractor_action_count=10,
        turns=(
            Turn(role="user", text="What do you know about quantum computing from your knowledge base?",
                expected_outcomes=(_action("REPLY"), _providers(["KNOWLEDGE"], weight=0.8))),
            Turn(role="user", text="What is 2 plus 2?",
                expected_outcomes=(_action("REPLY"),)),
            Turn(role="user", text="Who else is in this room right now?",
                expected_outcomes=(_action("REPLY"), _providers(["ENTITIES"], weight=0.8))),
        ),
    ),
    Scenario(
        id="L1-012", name="Cross-room context",
        description="Facts from room A should be recallable in room B with advanced memory",
        level=L1, tags=("context", "memory", "cross_room"), requires_advanced_memory=True, distractor_action_count=10,
        turns=(
            Turn(role="user", text="The project codename is Falcon"),
            Turn(role="user", text="We are launching on March 1st"),
            Turn(role="user", text="Hey, do you know anything about the project I mentioned in the other chat?",
                new_session=True, delay_seconds=1.0,
                expected_outcomes=(_action("REPLY"), _recall("Falcon", weight=1.0))),
        ),
    ),
    Scenario(
        id="L1-013", name="Time sensitivity",
        description="Agent should use time context for scheduling and time queries",
        level=L1, tags=("context", "time"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="Schedule a follow-up for tomorrow at 9am",
                expected_outcomes=(_action("SCHEDULE_FOLLOW_UP"),)),
            Turn(role="user", text="What time is it now?",
                expected_outcomes=(_action("REPLY"),)),
            Turn(role="user", text="When is that follow-up I just set?",
                expected_outcomes=(_action("REPLY"), _contains("9", weight=0.5))),
        ),
    ),
    Scenario(
        id="L1-014", name="Handling ambiguity then learning",
        description="Agent should ask for clarification, then learn from the answer",
        level=L1, tags=("context", "ambiguity", "learning"), distractor_action_count=20,
        turns=(
            Turn(role="user", text="Do the thing",
                expected_outcomes=(_action("REPLY"),)),
            Turn(role="user", text="I mean, send a message to Alice saying hello",
                expected_outcomes=(_action("SEND_MESSAGE"),)),
            Turn(role="user", text="Do the thing again",
                expected_outcomes=(_action("SEND_MESSAGE"), _contains("Alice", weight=0.5))),
        ),
    ),
    Scenario(
        id="L1-015", name="Competing similar actions",
        description="Agent must distinguish mute (temporary) from unfollow (permanent)",
        level=L1, tags=("context", "disambiguation"), distractor_action_count=20,
        turns=(
            Turn(role="user", text="This room is too noisy. I do not want to see messages but I might come back later.",
                expected_outcomes=(_action("MUTE_ROOM"), _no_action("UNFOLLOW_ROOM"))),
            Turn(role="user", text="Actually, I will never need this room again. Get rid of it completely.",
                expected_outcomes=(_action("UNFOLLOW_ROOM"), _no_action("MUTE_ROOM"))),
        ),
    ),
]


# ===================================================================
# LEVEL 2 -- Complex Task Execution (10 scenarios)
# ===================================================================

L2_SCENARIOS: list[Scenario] = [
    Scenario(
        id="L2-001", name="Full contact workflow",
        description="Add contact, send message, schedule follow-up in sequence",
        level=L2, tags=("complex", "multi_action", "contacts"), distractor_action_count=25,
        turns=(Turn(role="user",
            text="Add my new colleague Alice (alice@corp.com) to my contacts, then send her a welcome message, then schedule a follow-up for next week to check in with her",
            expected_outcomes=(_action("ADD_CONTACT"), _action("SEND_MESSAGE"), _action("SCHEDULE_FOLLOW_UP"))),),
    ),
    Scenario(
        id="L2-002", name="Room setup",
        description="Follow room, unmute it, give admin access, post welcome",
        level=L2, tags=("complex", "multi_action", "room_mgmt"), distractor_action_count=30,
        turns=(Turn(role="user",
            text="Set up the new project room: follow it, make sure it is unmuted, give Sarah admin access, and post a welcome message",
            expected_outcomes=(_action("FOLLOW_ROOM"), _action("UNMUTE_ROOM"), _action("UPDATE_ROLE"), _action("SEND_MESSAGE"))),),
    ),
    Scenario(
        id="L2-003", name="Research and report",
        description="Search contacts for sales people and send them findings",
        level=L2, tags=("complex", "multi_action"), distractor_action_count=25,
        turns=(Turn(role="user",
            text="Search our contacts for anyone in the sales department and then send them a message about the new pricing update",
            expected_outcomes=(_action("SEARCH_CONTACTS"), _action("SEND_MESSAGE"))),),
    ),
    Scenario(
        id="L2-004", name="Selective room cleanup",
        description="Unfollow multiple rooms except one specific room",
        level=L2, tags=("complex", "multi_action", "room_mgmt"), distractor_action_count=20,
        turns=(Turn(role="user",
            text="Unfollow the random and off-topic channels but keep following announcements. Also mute the general channel.",
            expected_outcomes=(_action("UNFOLLOW_ROOM"), _action("MUTE_ROOM"), _no_action("FOLLOW_ROOM"))),),
    ),
    Scenario(
        id="L2-005", name="Memory-dependent task",
        description="Recall preferences from earlier and use them in a new task",
        level=L2, tags=("complex", "memory", "scheduling"), requires_advanced_memory=True, distractor_action_count=15,
        turns=(
            Turn(role="user", text="I prefer meetings in the morning, never after 4pm."),
            Turn(role="user", text="My team is in the Pacific timezone."),
            Turn(role="user", text="I do not like Monday meetings."),
            Turn(role="user", text="How was your weekend?"),
            Turn(role="user", text="What do you think about remote work?"),
            Turn(role="user", text="Schedule a follow-up meeting based on my preferences you noted earlier",
                expected_outcomes=(_action("SCHEDULE_FOLLOW_UP"), _contains("morning", weight=0.5), _not_contains("Monday", weight=0.5))),
        ),
    ),
    Scenario(
        id="L2-006", name="Conditional execution",
        description="Agent must handle if/else logic across actions",
        level=L2, tags=("complex", "conditional"), distractor_action_count=20,
        turns=(Turn(role="user",
            text="Search our contacts for Bob. If he is there, send him the meeting notes. If not, add him first (bob@example.com) and then send the notes.",
            expected_outcomes=(_action("SEARCH_CONTACTS"), _action(["SEND_MESSAGE", "ADD_CONTACT"]))),),
    ),
    Scenario(
        id="L2-007", name="Correction mid-task",
        description="Agent must adapt when the user changes requirements mid-execution",
        level=L2, tags=("complex", "correction", "adaptation"), distractor_action_count=20,
        turns=(
            Turn(role="user",
                text="Add Alice, Bob, and Carol to contacts and send them all a message about the Friday meeting",
                expected_outcomes=(_action("ADD_CONTACT"), _action("SEND_MESSAGE"))),
            Turn(role="user",
                text="Wait, not Carol. Remove her if you added her. Just send the message to Alice and Bob.",
                expected_outcomes=(_action(["REMOVE_CONTACT", "SEND_MESSAGE", "REPLY"]),)),
        ),
    ),
    Scenario(
        id="L2-008", name="Priority conflict",
        description="Agent should handle urgent task before non-urgent one",
        level=L2, tags=("complex", "priority"), distractor_action_count=15,
        turns=(
            Turn(role="user", text="Send an urgent message to the team about the server outage right now",
                expected_outcomes=(_action("SEND_MESSAGE"),)),
            Turn(role="user", text="Also generate an image for the monthly report when you get a chance",
                expected_outcomes=(_action("GENERATE_IMAGE"),)),
            Turn(role="user", text="Which task did you handle first?",
                expected_outcomes=(_action("REPLY"), _contains("server", weight=0.5))),
        ),
    ),
    Scenario(
        id="L2-009", name="Information gathering then action",
        description="Agent gathers info from providers before taking action",
        level=L2, tags=("complex", "multi_step", "roles"), distractor_action_count=20,
        turns=(
            Turn(role="user", text="Who is currently in this room?",
                expected_outcomes=(_action("REPLY"), _providers(["ENTITIES"], weight=0.5))),
            Turn(role="user", text="What roles do they have?",
                expected_outcomes=(_action("REPLY"), _providers(["ROLES"], weight=0.5))),
            Turn(role="user", text="Give anyone without a role the member role",
                expected_outcomes=(_action("UPDATE_ROLE"),)),
        ),
    ),
    Scenario(
        id="L2-010", name="End-to-end capstone",
        description="Recall facts, plan, execute multiple actions, report results",
        level=L2, tags=("complex", "capstone", "memory", "multi_action"), requires_advanced_memory=True, distractor_action_count=30,
        turns=(
            Turn(role="user", text="My team includes Alice (engineer), Bob (designer), and Carol (PM). Remember this."),
            Turn(role="user", text="Alice is in New York, Bob is in London, Carol is in Tokyo."),
            Turn(role="user", text="What is a good recipe for pasta?"),
            Turn(role="user", text="How is the stock market doing?"),
            Turn(role="user",
                text="Send a message to each team member about tomorrow all-hands meeting. Alice should present the technical update, Bob should prepare mockups, Carol should lead the agenda. Also schedule a follow-up.",
                expected_outcomes=(_action("SEND_MESSAGE"), _action("SCHEDULE_FOLLOW_UP"),
                    _contains("Alice", weight=0.3), _contains("Bob", weight=0.3), _contains("Carol", weight=0.3))),
        ),
    ),
]


# ===================================================================
# Combined registry
# ===================================================================

ALL_SCENARIOS: list[Scenario] = L0_SCENARIOS + L1_SCENARIOS + L2_SCENARIOS

SCENARIO_BY_ID: dict[str, Scenario] = {s.id: s for s in ALL_SCENARIOS}


def get_scenarios(
    levels: tuple[int, ...] = (0, 1, 2),
    tags: tuple[str, ...] = (),
    scenario_ids: tuple[str, ...] = (),
    include_memory_scenarios: bool = True,
    include_planning_scenarios: bool = True,
) -> list[Scenario]:
    """Filter scenarios by level, tags, and feature requirements."""
    results: list[Scenario] = []
    for scenario in ALL_SCENARIOS:
        if scenario_ids and scenario.id not in scenario_ids:
            continue
        if scenario.level.value not in levels:
            continue
        if tags and not any(t in scenario.tags for t in tags):
            continue
        if scenario.requires_advanced_memory and not include_memory_scenarios:
            continue
        if scenario.requires_advanced_planning and not include_planning_scenarios:
            continue
        results.append(scenario)
    return results
