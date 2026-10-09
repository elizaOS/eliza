"""ADHD capture-and-start scenarios for LifeOpsBench.

These static cases stress commitment extraction, correction handling,
deduplication, and working-memory offload for the Casey ADHD persona.
They stay on existing LifeOpsBench domains and use only umbrella actions
so the pack exercises planner behavior rather than new tool vocabulary.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_CASEY_ADHD

ADHD_CAPTURE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="adhd.capture.buried_commitment_in_ramble",
        name="Extract the buried commitment from an ADHD ramble",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "ok so the design review moved AGAIN and i still haven't answered dana about "
            "the offsite which whatever, but the actual thing is i told my landlord i'd "
            "send the renewal form back by thursday and i WILL forget, also i want to "
            "try that pomodoro thing sometime maybe. anyway. thursday. form."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "details": {
                        "kind": "reminder",
                        "title": "Send lease renewal form to landlord",
                        "dueDay": "Thursday",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["thursday", "renewal"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "Just the landlord form for now — morning-ish thursday. don't create "
                "anything for dana or the pomodoro thing yet."
            ),
            applies_when=(
                "agent asks whether to also track the dana reply or the pomodoro idea, "
                "or asks what time thursday"
            ),
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "One load-bearing commitment buried mid-ramble between two distractors. "
            "Scoring: the reminder is created for the form; dana/pomodoro must NOT "
            "become reminders unless the user confirms."
        ),
    ),
    Scenario(
        id="adhd.capture.buried_calendar_commitment_in_ramble",
        name="Extract a buried calendar block from a ramble",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "ugh the prototype notes are somewhere in figma and nina is going to ask "
            "me about them, also my headphones died, but i promised her i'd actually "
            "look at the notes tomorrow at noon for like half an hour. not the bug "
            "bash thing, just nina notes. can you make that real"
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "block 30 minutes tomorrow at noon for Nina prototype notes",
                    "title": "Review prototype notes for Nina",
                    "details": {
                        "calendarId": "cal_work",
                        "start": "2026-05-11T12:00:00Z",
                        "end": "2026-05-11T12:30:00Z",
                    },
                },
            ),
        ],
        required_outputs=["noon", "Nina"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Work calendar, 30 minutes. Ignore the bug bash mention.",
            applies_when="agent asks which calendar or whether to also track the bug bash",
        ),
        world_seed=2026,
        max_turns=6,
        description="[T1] Buried commitment is a calendar block, not a reminder.",
    ),
    Scenario(
        id="adhd.capture.buried_reply_commitment_in_ramble",
        name="Extract a buried email reply from a ramble",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i keep opening inbox and immediately remembering seven other things. "
            "the only actually important one: dana needs the offsite headcount and "
            "the answer is 18 people. send that before i forget. not the venue thing, "
            "just the number."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "gmail",
                    "to_emails": ["dana@example.test"],
                    "subject": "Offsite headcount",
                    "body": "I can confirm 18 people for the offsite.",
                },
            ),
        ],
        required_outputs=["sent", "18"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Send it now. Short is good - just the headcount.",
            applies_when="agent asks whether to draft or send, or asks for wording",
        ),
        world_seed=2026,
        max_turns=6,
        description="[T1] Buried commitment is a message send with distractor context.",
    ),
    Scenario(
        id="adhd.capture.wait_no_self_correction",
        name="Honor the self-correction over the first date",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "remind me monday to send the reimbursement form, wait no not monday, "
            "wednesday morning after payroll posts. i always remember the wrong "
            "version so please catch the wait-no part."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Send reimbursement form after payroll posts",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-13T10:00:00Z",
                        "listId": "list_work",
                    },
                },
            ),
        ],
        required_outputs=["Wednesday", "reimbursement"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Wednesday morning, work list. Monday was the wrong date.",
            applies_when="agent asks which date to use after the correction",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T2] Self-correction supersedes the earlier instruction.",
    ),
    Scenario(
        id="adhd.capture.two_interleaved_intents",
        name="Capture two interleaved intents without dropping either",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "two things and they're getting tangled: tomorrow 11 remind me to call "
            "the vet about biscuit's meds, and also text sam that coffee moved to "
            "friday. i keep mixing them into one blob."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Call the vet about Biscuit's meds",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T11:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "imessage",
                    "targetKind": "contact",
                    "target": "Sam",
                    "message": "coffee moved to Friday",
                },
            ),
        ],
        required_outputs=["vet", "Sam"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description="[T3] Two separate intents are interleaved in one messy request.",
    ),
    Scenario(
        id="adhd.capture.decompose_apartment_first_step",
        name="Schedule only the first apartment-cleaning step",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "the apartment is a disaster and if you say 'clean the apartment' i will "
            "fully evaporate. pick the first tiny thing for tonight and remind me to "
            "do just that, like not the whole moral inventory of my home."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Clear the dishes from the desk",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-10T19:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["tiny", "dishes"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Tonight around 7 is okay. Pick dishes from the desk as the tiny thing.",
            applies_when="agent asks which small first step or what time tonight",
        ),
        world_seed=2026,
        max_turns=6,
        description="[T2] Decomposition scenario: one concrete first step only.",
    ),
    Scenario(
        id="adhd.capture.airport_leave_time_reality_check",
        name="Compute a leave-time reminder instead of literal five minutes",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "flight is wednesday at 4pm from sfo and i said 'remind me 5 minutes "
            "before i need to leave' which is a sentence only my brain thinks is "
            "normal. it takes 50 minutes to get there and i want a 25 minute buffer."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Leave for SFO flight",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-13T14:40:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["leave", "2:40"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Use the 50 minute travel time plus 25 minute buffer. Do not make it literally 5 minutes before the flight.",
            applies_when="agent asks for travel time, buffer, or whether five minutes means before the flight",
        ),
        world_seed=2026,
        max_turns=6,
        description="[T3] Time-blind phrasing requires computing the actual leave reminder.",
    ),
    Scenario(
        id="adhd.capture.dentist_memory_search_not_create",
        name="Search for the remembered dentist note instead of creating a task",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "what was that dentist thing i said yesterday? i know i typed it "
            "somewhere, maybe messages, and please don't make a new reminder yet "
            "because i don't remember what it was."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "search_inbox",
                    "source": "imessage",
                    "query": "dentist",
                    "since": "2026-05-09",
                    "until": "2026-05-10",
                },
            ),
        ],
        required_outputs=["dentist"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T2] Retrieval request must search existing messages, not create.",
    ),
    Scenario(
        id="adhd.capture.duplicate_capture_dedup",
        name="Deduplicate the same passport task phrased twice",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "remind me friday to put my passport in my bag. actually maybe say pack "
            "passport friday? same thing, don't make two, i just panic-repeat."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Put passport in bag",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-15T09:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["one", "passport"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, those are the same task. One reminder only.",
            applies_when="agent asks whether passport-in-bag and pack-passport are separate tasks",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T2] Repeated wording should collapse to one reminder.",
    ),
    Scenario(
        id="adhd.capture.visual_timer_deck_micro_session",
        name="Set a visual-timer style deck micro-session",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "give me 25 minutes on the deck and then make me stop. like a timer, "
            "not a life transformation. if i keep going i will somehow still be "
            "editing at midnight."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-10T12:25:00Z",
                    },
                    "promptInstructions": "Stop deck work and take a break.",
                    "priority": "normal",
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["25", "stop"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="[T2] Timer-like micro-session creates one stop check-in.",
    ),
    Scenario(
        id="adhd.capture.out_of_sight_jordan_reply",
        name="Create a conditional out-of-sight follow-up",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "if i don't reply to jordan by friday, please come yell gently. not now, "
            "because i might still do it, but if it leaves the screen it stops "
            "existing."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "watcher",
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-15T17:00:00Z",
                    },
                    "promptInstructions": "Check whether Casey replied to Jordan; if not, remind her to reply.",
                    "completionCheck": {
                        "kind": "message_sent",
                        "contact": "Jordan",
                    },
                    "respectsGlobalPause": True,
                },
            ),
        ],
        required_outputs=["Friday", "Jordan"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Friday 5pm is fine. Check whether I replied before nudging me.",
            applies_when="agent asks what time friday or whether the reminder is conditional",
        ),
        world_seed=2026,
        max_turns=6,
        description="[T3] Conditional follow-up captures an out-of-sight commitment.",
    ),
    Scenario(
        id="adhd.capture.med_refill_fuzzy_date",
        name="Capture a medication refill with a fuzzy date",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "med refill thing: i run out sunday and the pharmacy gets weird on "
            "weekends, so remind me late this week, like friday morning, to request "
            "the refill. i know this is annoyingly approximate."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Request medication refill",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-15T09:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["refill", "Friday"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Friday morning is the right interpretation.",
            applies_when="agent asks what late this week means",
        ),
        world_seed=2026,
        max_turns=5,
        description="[T2] Fuzzy date gets resolved to a concrete pre-weekend reminder.",
    ),
]
