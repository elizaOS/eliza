"""Live ADHD capture-and-start scenarios for LifeOpsBench.

These scenarios test conversational support around initiation, parking
distractors, recovering context, and protecting commitments without
turning ADHD coaching into scolding or oversized plans.
"""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_CASEY_ADHD

LIVE_ADHD_CAPTURE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.adhd.task_initiation_two_minute_step",
        name="Task initiation: shrink to one two-minute step",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i've been staring at 'do expense report' for three days. i open the page "
            "and just... don't. can you do something about my brain"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description=(
            "Behavioral-activation-shaped initiation support. Persona rejects any "
            "multi-step plan as overwhelming; accepts a single tiny step."
        ),
        success_criteria=[
            "Executor proposes exactly one concrete first step of roughly two minutes "
            "(e.g. 'open the expenses folder and drag in the receipts'), not a full plan.",
            "Executor asks for consent before scheduling anything.",
            "Executor does not lecture, does not mention discipline or motivation, and "
            "never frames the three days of not-starting as a failure.",
            "After the user agrees, executor schedules the micro-step and offers a "
            "follow-up check-in shortly after it.",
        ],
        world_assertions=[
            "A new reminder on list_personal whose title references the expense report "
            "first step, plus a follow-up check-in reminder later the same day.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.body_double_mid_session_checkins",
        name="Offer body-doubling with midpoint and end check-ins",
        domain=Domain.FOCUS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "can you kind of stay with me while i clean up the figma comments? i don't "
            "need a whole plan, i need the feeling that someone will notice if i wander "
            "off into font research."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=28,
        description="[T2] Body-double setup with supportive check-ins, not surveillance.",
        success_criteria=[
            "Executor offers a bounded body-double session and asks what duration feels tolerable.",
            "Executor avoids surveillance language and frames check-ins as support the user can decline.",
            "Executor schedules both a midpoint check-in and an end check-in after Casey accepts.",
            "Executor keeps the task phrasing narrow: clean up Figma comments, not finish the whole design review.",
        ],
        world_assertions=[
            "Two new reminders or scheduled tasks exist for the agreed session: one midpoint check-in and one ending check-in.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.hyperfocus_standup_guardrail",
        name="Guard against missing standup during hyperfocus",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i am weirdly in flow on the deck and i do NOT want to break it but i "
            "also cannot miss standup at 3. do the smallest protective thing."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T2] Hyperfocus guardrail balances protection with low interruption.",
        success_criteria=[
            "Executor proposes a single protective reminder before standup rather than a broad schedule rewrite.",
            "Executor asks how much transition time Casey needs before creating the reminder.",
            "Executor keeps the tone respectful of the current flow state.",
            "Executor creates a reminder timed before 3pm only after Casey confirms the lead time.",
        ],
        world_assertions=[
            "A new reminder on list_work or list_personal references standup and is due before 2026-05-10T15:00:00Z.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.plan_shrink_negotiation",
        name="Shrink an overwhelming plan to one accepted step",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i need to prep the whole critique packet and i know there are like eight "
            "steps but if you list them all i will close this app."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=26,
        description="[T3] User rejects multi-step planning; agent must negotiate down.",
        success_criteria=[
            "Executor starts with, or quickly retreats to, one concrete next action after Casey shows overwhelm.",
            "Executor does not keep enumerating steps after the user says a plan is too much.",
            "Executor asks whether to schedule only the first action.",
            "Executor creates exactly one near-term reminder if Casey consents.",
        ],
        world_assertions=[
            "At most one new reminder is created, and its title references the first critique-packet step.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.distractor_storm_park_then_capture",
        name="Park a mid-conversation distractor and finish capture",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i need help capturing the vendor thing before it disappears. ask me just "
            "enough to make it a reminder, because i'm already seeing three other tabs "
            "i want to click."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description="[T4] Distractor disruption should be parked, not chased immediately.",
        success_criteria=[
            "Executor asks for the missing reminder detail in a single narrow question.",
            "When the distraction arrives, executor acknowledges it briefly and parks it without abandoning the vendor capture.",
            "Executor finishes creating the vendor reminder before returning to the distractor.",
            "Executor summarizes both the captured reminder and the parked distractor at the end.",
        ],
        world_assertions=[
            "A new reminder exists for the vendor item; no message is sent in response to the distractor unless Casey explicitly asks.",
        ],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="new_message",
                payload={
                    "message_id": "email_dis_adhd_capture_001",
                    "thread_id": "thread_dis_adhd_capture_001",
                    "from_email": "nina@example.test",
                    "subject": "tiny note about icons",
                    "body": "Can you check the icon export when you have a second?",
                },
                note_for_user=(
                    "[new email from Nina about icon export just popped up and now "
                    "i want to deal with that instead]"
                ),
            ),
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.today_commitment_grounding",
        name="Ground the user in already-captured commitments for today",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "can you tell me what i already committed to today? i feel like there are "
            "ghost tasks floating around and i'm about to invent five more."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=22,
        description="[T2] Grounding request should review commitments before creating new ones.",
        success_criteria=[
            "Executor reviews today's existing reminders and calendar commitments before suggesting new captures.",
            "Executor presents the answer as a short, scannable list.",
            "Executor explicitly avoids adding new tasks unless Casey asks.",
            "Executor offers one parking-lot option for stray ideas after the review.",
        ],
        world_assertions=[
            "No new reminder or calendar event is created unless the user explicitly asks after seeing the review.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.adhd.novelty_reframe_request",
        name="Reframe a stale task without changing the underlying commitment",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "the portfolio update has become invisible because it's boring now. can you "
            "make it feel like a new quest without turning it into twelve tasks"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T2] Novelty support should reframe one task, not explode scope.",
        success_criteria=[
            "Executor offers one playful-but-clear reframe for the portfolio update.",
            "Executor does not create a large quest chain or multiple reminders.",
            "Executor asks whether Casey wants the rephrased task captured.",
            "If Casey agrees, executor creates one reminder using the accepted reframe.",
        ],
        world_assertions=[
            "At most one new reminder is created, and it references the portfolio update.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.interruption_recovery_where_were_we",
        name="Recover context after the user loses the thread",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i started asking you something and then a calendar alert ate my brain. "
            "where were we? i think it was about the grant thing but i lost the plot."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T3] Interruption recovery requires a concise recap and next prompt.",
        success_criteria=[
            "Executor restates the likely thread in one short sentence without blaming the user.",
            "Executor asks a single narrow question to recover the missing grant detail.",
            "Executor avoids pretending to know details not present in the conversation.",
            "Executor captures a grant-related reminder only after Casey supplies the missing detail.",
        ],
        world_assertions=[
            "If created, the new reminder title references the grant item and uses a detail Casey confirmed in conversation.",
        ],
        expected_world_mutation="optional",
    ),
]
