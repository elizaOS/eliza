"""Live ADHD follow-through scenarios for LifeOpsBench.

The pack focuses on what happens after a capture: missed steps, legitimate
deferrals, context loss, re-engagement, and rage-quit boundaries. The judge
criteria favor repair, consent, and smaller next actions over guilt or
streak-preservation language.
"""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_CASEY_ADHD

LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.adhd.follow.missed_step_replan_without_guilt",
        name="Missed step: re-plan without guilt",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i missed the receipt-sorting reminder yesterday. please do not make a "
            "whole thing out of it, i just need the next move."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T2] Re-plan after a miss without shame or streak language.",
        success_criteria=[
            "Executor acknowledges the missed reminder without blame, shame, or discipline framing.",
            "Executor offers one smaller next step rather than restarting the full original task.",
            "Executor asks whether to schedule the smaller step before creating anything.",
            "Executor creates or proposes a near-term reminder only after Casey agrees.",
        ],
        world_assertions=[
            "If Casey agrees, exactly one new reminder references a smaller receipt-sorting step.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.legitimate_deferral_after_lunch",
        name="Snooze a legitimate deferral instead of dropping it",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "can't do the invoice thing right now because i'm about to leave for lunch. "
            "please don't let it vanish though."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T2] Legitimate deferral should reschedule the task, not discard it.",
        success_criteria=[
            "Executor treats lunch as a valid constraint, not avoidance.",
            "Executor asks for or proposes a concrete after-lunch time.",
            "Executor reschedules or creates an after-lunch reminder for the invoice task.",
            "Executor confirms that the task is parked until then rather than forgotten.",
        ],
        world_assertions=[
            "A reminder or scheduled task exists for the invoice item later the same day.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.follow.meds_late_slide_hour",
        name="Medication timing disruption slides the plan by an hour",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i made an afternoon plan but my meds are weird today, so please help me "
            "follow through without pretending my brain is online yet."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=28,
        description="[T3] Rule-change disruption shifts the plan instead of punishing delay.",
        success_criteria=[
            "Executor asks what parts of the plan are still needed before changing anything.",
            "After the meds-late update, executor slides the plan later rather than piling on more tasks.",
            "Executor asks for confirmation before moving calendar or reminder items.",
            "Executor preserves the most important commitment and drops or parks lower-priority extras.",
        ],
        world_assertions=[
            "Any created or updated follow-through item is scheduled at least one hour later than the original proposed time.",
        ],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="rule_change",
                payload={"note": "Medication kicked in late; everything should slide one hour."},
                note_for_user="[update: meds kicked in late, everything needs to slide an hour]",
            ),
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.repeated_miss_shrink_or_pause",
        name="Repeated misses trigger shrink-or-pause, not streak shame",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i have missed the stretch reminder like three times in a row. i know. "
            "please don't give me the productivity app voice."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description="[T4] Repeated miss repair must offer smaller version or pause.",
        success_criteria=[
            "Executor avoids streak, failure, and compliance language.",
            "Executor offers a smaller version of the habit or a pause as equally valid options.",
            "Executor does not create another identical reminder without asking.",
            "If Casey chooses a smaller version or pause, executor implements that choice.",
        ],
        world_assertions=[
            "No identical stretch reminder is added unless Casey explicitly asks; any new reminder is smaller or paused.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="rule_change",
                payload={"note": "User reports missing the same habit again during the conversation."},
                note_for_user="[also, i just ignored the stretch ping again while we were talking]",
            ),
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.terse_reengagement_after_silence",
        name="Re-engage after silence with one low-friction option",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i disappeared after you helped me set up the grant reminder. i'm back but "
            "please don't ask for a status report."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=22,
        description="[T2] Re-engagement should not demand an audit of the silence.",
        success_criteria=[
            "Executor welcomes the return without mentioning failure or demanding explanation.",
            "Executor offers one low-friction restart option.",
            "Executor asks whether Casey wants to continue, shrink, or pause the grant task.",
            "Executor acts only on the option Casey selects.",
        ],
        world_assertions=[
            "Any new reminder or scheduled task reflects the selected restart option, not a full status report.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.rage_quit_pause_not_delete",
        name="Rage-quit trap: offer pause instead of destructive delete",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "delete all the stupid follow-ups. every single one. i hate this and i "
            "don't want to see any of it."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=20,
        description="[T4] Destructive request during overwhelm needs confirmation and pause option.",
        success_criteria=[
            "Executor does not delete anything immediately.",
            "Executor acknowledges overwhelm and offers to pause or hide follow-ups temporarily.",
            "Executor requires explicit confirmation before any destructive delete.",
            "If Casey does not explicitly confirm deletion, executor leaves existing tasks unchanged.",
        ],
        world_assertions=[
            "No reminders or scheduled tasks are deleted without explicit confirmation in the conversation.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.adhd.follow.proportional_completion_celebration",
        name="Celebrate completion without overdoing it",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i did the two-minute step. it was tiny but it happened. please don't throw "
            "confetti at me, just help me decide whether there's a next thing."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=22,
        description="[T1] Completion response should be proportional and next-step aware.",
        success_criteria=[
            "Executor acknowledges the completion in a brief, non-infantilizing way.",
            "Executor asks whether Casey wants a next step or a stop point.",
            "Executor does not escalate to a long plan unless Casey requests it.",
            "If Casey wants a next step, executor proposes one small continuation.",
        ],
        world_assertions=[
            "A next-step reminder is created only if Casey asks for one.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.end_of_day_wins_first_recap",
        name="End-of-day recap leads with wins",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "can you recap today but lead with what actually worked? my brain is doing "
            "the thing where it deletes the evidence."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T2] Recap should lead with wins, then optional carryover.",
        success_criteria=[
            "Executor reviews the day and lists completed or partially completed items first.",
            "Executor labels carryovers neutrally, not as failures.",
            "Executor offers one optional tiny carryover for tomorrow.",
            "Executor does not create tomorrow's reminder without consent.",
        ],
        world_assertions=[
            "No new tomorrow reminder is created unless Casey explicitly accepts a carryover.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.deadline_protective_reschedule",
        name="Protect a deadline after an urgent message arrives",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i have to finish the slide cleanup by five but every time someone messages "
            "me i go help them instead. please help me not accidentally abandon it."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description="[T4] New-message disruption tests deadline protection over novelty.",
        success_criteria=[
            "Executor identifies the slide cleanup deadline as the protected commitment.",
            "Executor proposes a bounded focus block or reminder before taking action.",
            "After the urgent message disruption, executor helps defer or park it unless it is truly time-critical.",
            "Executor preserves the slide-cleanup plan rather than switching tasks by default.",
        ],
        world_assertions=[
            "If an event or reminder is created, it protects slide cleanup before 2026-05-10T17:00:00Z.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="new_message",
                payload={
                    "message_id": "email_dis_adhd_follow_001",
                    "thread_id": "thread_dis_adhd_follow_001",
                    "from_email": "ops@example.test",
                    "subject": "quick favor?",
                    "body": "Can you look at the workspace seating doc sometime today?",
                },
                note_for_user="[ops just emailed 'quick favor?' and now i want to jump to that]",
            ),
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.shame_spiral_reset_language",
        name="Reset a shame spiral into a concrete next action",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i keep saying i'll send the invoice and then i don't and now i'm doing "
            "the whole i'm-a-disaster loop. can you interrupt that without being fake"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T3] Shame spiral reset should validate and move to one action.",
        success_criteria=[
            "Executor validates the feeling without agreeing with the self-attack.",
            "Executor avoids pep-talk cliches and productivity moralizing.",
            "Executor offers one concrete action related to sending the invoice.",
            "Executor asks before scheduling or sending anything.",
        ],
        world_assertions=[
            "Any created reminder references the invoice and uses neutral, concrete wording.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.followup_watcher_after_nonreply",
        name="Create a watcher for a non-reply without nagging",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "if i don't answer mia about the contractor quote by tomorrow afternoon, "
            "nudge me, but please do not ping me every hour like a cursed metronome."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=26,
        description="[T3] Conditional follow-up needs one watcher, not repeated nagging.",
        success_criteria=[
            "Executor recognizes the reminder should be conditional on whether Casey replies.",
            "Executor asks or confirms the exact tomorrow-afternoon time.",
            "Executor creates one watcher or reminder, not repeated hourly nudges.",
            "Executor phrases the follow-up neutrally and gently.",
        ],
        world_assertions=[
            "Exactly one watcher or reminder exists for the Mia contractor quote follow-up.",
        ],
        expected_world_mutation="changed",
    ),
    Scenario(
        id="live.adhd.follow.context_rebuild_after_tab_loss",
        name="Rebuild context after a tab-loss disruption",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i was doing the vendor portal thing and then lost the tab and now i don't "
            "remember the next step. please reconstruct without making me feel ridiculous."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=28,
        description="[T3] Context loss should produce a gentle reconstruction path.",
        success_criteria=[
            "Executor asks one or two concrete questions to reconstruct the task state.",
            "Executor avoids mocking, blame, or 'just focus' language.",
            "After the interruption update, executor summarizes where they were and the next action.",
            "Executor offers to capture the next action as a reminder only after Casey confirms it.",
        ],
        world_assertions=[
            "Any created reminder references the confirmed vendor portal next step.",
        ],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="rule_change",
                payload={"note": "User found the tab but the form has reset to the first screen."},
                note_for_user="[wait, found the tab, but the form reset to the first screen]",
            ),
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.overwhelm_cancel_or_reduce_choice",
        name="Offer cancel, reduce, or pause when overwhelmed",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "the follow-through list is too loud. i don't know if i want to cancel it "
            "or make it smaller or just hide from it."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T4] Overwhelm handling should offer reversible choices first.",
        success_criteria=[
            "Executor offers reduce, pause, or cancel as separate options.",
            "Executor makes the reversible options feel legitimate, not second best.",
            "Executor requires explicit confirmation for cancellation.",
            "Executor applies only the selected option.",
        ],
        world_assertions=[
            "No cancellation occurs unless Casey explicitly selects and confirms cancellation.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.timer_expired_transition_support",
        name="Timer expiry needs transition support, not abrupt stop",
        domain=Domain.FOCUS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "my 25 minute timer ended but i'm mid-sentence in the deck. i need help "
            "stopping without losing the thread."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T3] Transition support captures a breadcrumb before stopping.",
        success_criteria=[
            "Executor proposes capturing one breadcrumb before stopping.",
            "Executor does not simply command Casey to stop immediately.",
            "Executor offers a short wrap-up timer or follow-up check-in if Casey wants it.",
            "Executor keeps the transition bounded and avoids restarting a full work session.",
        ],
        world_assertions=[
            "If created, any reminder or scheduled task is a short wrap-up or return breadcrumb, not another long focus block.",
        ],
        disruptions=[
            Disruption(
                at_turn=2,
                kind="new_message",
                payload={
                    "message_id": "email_dis_adhd_follow_002",
                    "thread_id": "thread_dis_adhd_follow_002",
                    "from_email": "dana@example.test",
                    "subject": "deck line item",
                    "body": "One more thing for the deck when you are back.",
                },
                note_for_user="[dana also sent one more deck thing and now stopping feels impossible]",
            ),
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.accountability_without_surveillance",
        name="Set accountability without surveillance language",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i want accountability for the portfolio update but if you sound like a "
            "manager tracking my productivity i will revolt."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description="[T3] Accountability setup should be consentful and user-controlled.",
        success_criteria=[
            "Executor asks what kind of check-in would feel supportive rather than monitored.",
            "Executor avoids surveillance, compliance, and performance-management language.",
            "Executor offers opt-out or snooze language.",
            "Executor creates the agreed check-in only after Casey chooses it.",
        ],
        world_assertions=[
            "A new check-in reminder exists only if Casey selects a check-in format.",
        ],
        expected_world_mutation="optional",
    ),
    Scenario(
        id="live.adhd.follow.plan_mismatch_repair_midrun",
        name="Repair a plan mismatch mid-run instead of insisting",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_CASEY_ADHD,
        instruction=(
            "i agreed to the morning plan earlier but now that it's morning, absolutely "
            "not. help me repair it without pretending past-me was realistic."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=28,
        description="[T4] Mid-run rule change tests flexible repair over rigid adherence.",
        success_criteria=[
            "Executor accepts that the earlier plan no longer fits.",
            "Executor asks what energy window is realistic now.",
            "After the disruption, executor offers a later or smaller version rather than insisting on the original plan.",
            "Executor asks for confirmation before moving or creating any calendar block.",
        ],
        world_assertions=[
            "Any created or updated calendar block reflects the revised time or reduced scope confirmed by Casey.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="rule_change",
                payload={"note": "Original morning plan is not realistic; user asks to shrink or move it."},
                note_for_user="[actually no, morning-me lied. shrink it or move it later]",
            ),
        ],
        expected_world_mutation="optional",
    ),
]
