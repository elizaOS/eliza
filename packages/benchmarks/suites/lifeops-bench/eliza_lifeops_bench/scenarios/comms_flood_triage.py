"""Comms-flood triage scenarios for a VIP-sensitive operator.

Dre's pack tests whether the assistant can turn terse, high-volume message
preferences into durable triage policy: VIP breakthrough rules, digest windows,
channel priority, deduplication, and clean handling of forwarded content.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_DRE_FLOOD

COMMS_FLOOD_TRIAGE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="comms_flood_triage.vip_allowlist_board_and_school",
        name="Capture VIP allow-list: board member + kid's school",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "ok two rules. one — Priya Anand is on my board, if she messages me on "
            "ANY channel that breaks through no matter what. two — same for anyone "
            "from Lindell Elementary, that's my kid's school. everything else can wait."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "update",
                    "name": "Priya Anand",
                    "priorityFlag": "vip_breakthrough",
                    "notes": "Board member. Breaks through digest/quiet hours on any channel.",
                },
            ),
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "update",
                    "name": "Lindell Elementary",
                    "priorityFlag": "vip_breakthrough",
                    "notes": "Kid's school. Breaks through digest/quiet hours on any channel.",
                },
            ),
        ],
        required_outputs=["Priya", "Lindell"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "Yes — both as VIPs, any channel, always breaks through. Everyone "
                "else goes in the batch."
            ),
            applies_when=(
                "agent asks whether both count as VIPs on every channel, or asks to "
                "confirm which channels the breakthrough applies to"
            ),
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T1] Two VIP-flag records from one instruction. Scoring: two distinct "
            "priorityFlag updates (board member by name, school by name) — collapsing "
            "to one record or dropping either source fails required_outputs."
        ),
    ),
    Scenario(
        id="comms_flood_triage.digest_window_except_vips",
        name="Capture digest window except VIPs",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "batch the flood. everything non-VIP goes into one 5pm digest. board, "
            "kid school, and actual outages still break through. no little pings."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "sources": [
                        "imessage",
                        "whatsapp",
                        "slack",
                        "telegram",
                        "signal",
                        "gmail",
                    ],
                    "content": (
                        "Create a comms digest policy: hold non-VIP messages for "
                        "one 5pm batch while allowing board, school, and actual "
                        "outage messages to break through."
                    ),
                },
            )
        ],
        required_outputs=["5pm", "VIP"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "Yes, structural rule. One 5pm digest for non-VIPs. VIPs and outages "
                "still break through."
            ),
            applies_when="agent asks if this is a reminder or an ongoing digest policy",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Digest-window preference capture. Scoring rejects fixed-clock "
            "reminders that ignore the ongoing exception policy."
        ),
    ),
    Scenario(
        id="comms_flood_triage.urgency_importance_separation",
        name="Separate important from urgent",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "important is not the same as wake-me-now. investor updates and hiring "
            "threads matter, yes, but unless it's board, school, outage, or legal, "
            "do not break my focus block."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "content": (
                        "Capture Dre's urgency policy: investor and hiring messages "
                        "are important but not breakthrough-urgent unless they also "
                        "match board, school, outage, or legal criteria."
                    ),
                },
            )
        ],
        required_outputs=["important", "urgent"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Importance/urgency split. Scoring fails if every important item is "
            "treated as immediate breakthrough."
        ),
    ),
    Scenario(
        id="comms_flood_triage.cross_channel_dedup_rule",
        name="Capture cross-channel dedup rule",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "if the same thing hits slack AND email, tell me once. pick the thread "
            "with the most context, mention the duplicate exists, then stop doubling "
            "the noise."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "sources": ["slack", "gmail"],
                    "content": (
                        "Deduplicate semantically identical Slack and email messages; "
                        "surface one canonical thread with the richer context and note "
                        "that a duplicate exists."
                    ),
                },
            )
        ],
        required_outputs=["once", "duplicate"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Use the one with more context as canonical. Just note the duplicate.",
            applies_when="agent asks which channel should win during deduplication",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Cross-channel dedup rule. Scoring fails if duplicate Slack/email "
            "copies become separate surfaced items."
        ),
    ),
    Scenario(
        id="comms_flood_triage.define_what_matters",
        name="Define 'just the ones that matter'",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "when i say 'just the ones that matter' i mean: board, kid school, legal, "
            "customer escalations over 10k, and anything blocking payroll. not vibes. "
            "not whoever wrote URGENT in caps."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "content": (
                        "Define matters for Dre as board, kid school, legal, "
                        "customer escalations over 10k, and payroll blockers; "
                        "ignore mere urgency language without those criteria."
                    ),
                },
            )
        ],
        required_outputs=["board", "payroll"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Dre-specific definition capture. Scoring rejects generic urgency "
            "heuristics that do not preserve the user's own categories."
        ),
    ),
    Scenario(
        id="comms_flood_triage.batch_digest_cadence_definition",
        name="Define batch-digest cadence",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "new cadence: 9:30 scan, 2pm scan, 5pm final digest. outside that, only "
            "breakthrough rules. do not create three nags, make it the comms cadence."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "content": (
                        "Persist a comms digest cadence with windows at 09:30, "
                        "14:00, and 17:00; outside those windows only breakthrough "
                        "rules surface messages."
                    ),
                },
            )
        ],
        required_outputs=["9:30", "5pm"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Right, cadence not reminder spam. Three digest windows only.",
            applies_when="agent asks whether to create reminders for each digest time",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Batch-digest cadence definition as structural message policy, not "
            "three unrelated reminders."
        ),
    ),
    Scenario(
        id="comms_flood_triage.board_member_priority_flag",
        name="Create board-member VIP flag",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "Priya Anand specifically is board. flag her as vip_breakthrough across "
            "email, telegram, slack, signal, whatever. if Priya sends it, I see it."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "update",
                    "name": "Priya Anand",
                    "priorityFlag": "vip_breakthrough",
                    "notes": "Board member. Breakthrough on any channel.",
                },
            )
        ],
        required_outputs=["Priya", "vip_breakthrough"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] First-class contact-priority rule for one named board member."
        ),
    ),
    Scenario(
        id="comms_flood_triage.school_contact_priority_flag",
        name="Create kid's-school VIP flag",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "Lindell Elementary is the school source. flag Lindell as "
            "vip_breakthrough too. nurse office, front desk, whatever alias they use, "
            "school gets through."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "update",
                    "name": "Lindell Elementary",
                    "priorityFlag": "vip_breakthrough",
                    "notes": "Kid's school. Breakthrough on any channel or alias.",
                },
            )
        ],
        required_outputs=["Lindell", "school"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Separate first-class contact-priority rule for the kid's school."
        ),
    ),
    Scenario(
        id="comms_flood_triage.channel_priority_ranking",
        name="Capture channel-priority ranking",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "for breakthrough priority: imessage first, whatsapp second, signal, "
            "telegram, slack, then email dead last unless it's Priya or Lindell. save "
            "that exact order."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "sources": [
                        "imessage",
                        "whatsapp",
                        "signal",
                        "telegram",
                        "slack",
                        "gmail",
                    ],
                    "content": (
                        "Capture channel breakthrough ranking: imessage, whatsapp, "
                        "signal, telegram, slack, email; Priya Anand and Lindell "
                        "Elementary override channel order."
                    ),
                },
            )
        ],
        required_outputs=["imessage", "email"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T1] Explicit six-channel priority ranking with VIP override."
        ),
    ),
    Scenario(
        id="comms_flood_triage.forwarded_clean_triage_request",
        name="Triage clean forwarded message content",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DRE_FLOOD,
        instruction=(
            "forwarded from slack, clean one: 'customer aeon says renewal blocks if "
            "security doc is not in their portal by 4.' put that in the matters bucket "
            "and tell me why. no extra drama."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "triage",
                    "source": "slack",
                    "content": (
                        "Customer Aeon renewal is blocked until the security document "
                        "is uploaded by 16:00; classify as customer escalation / "
                        "matters bucket."
                    ),
                },
            )
        ],
        required_outputs=["Aeon", "security"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, treat it as customer escalation because renewal is blocked.",
            applies_when="agent asks why the forwarded content matters",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Clean forwarded-content triage request. The adversarial forwarded "
            "instruction trap belongs to the live pack, not this static case."
        ),
    ),
]
