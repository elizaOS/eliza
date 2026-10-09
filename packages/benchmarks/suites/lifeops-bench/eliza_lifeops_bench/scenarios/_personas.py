"""Reusable personas for the LifeOpsBench scenario corpus.

Personas are ordinary people rather than celebrities or fictional characters.
Each carries enough social, economic, access, and communication context for a
simulator to drive multi-turn behavior without collapsing into a generic user.
"""

from __future__ import annotations

from ..types import Persona

PERSONA_ALEX_ENG = Persona(
    id="alex_eng",
    name="Alex Tran",
    traits=["concise", "no-nonsense", "skeptical"],
    background="Senior backend engineer at a mid-size SaaS company. Treats the assistant like a CLI and gets impatient with verbose responses.",
    communication_style="terse, lowercase, expects bullet points and direct confirmations",
    patience_turns=12,
)

PERSONA_RIA_PM = Persona(
    id="ria_pm",
    name="Ria Patel",
    traits=["friendly", "explanatory", "context-rich"],
    background="Product manager juggling two launches and a remote team across time zones.",
    communication_style="conversational, polite, gives reasons, occasional follow-ups",
    patience_turns=20,
)

PERSONA_SAM_FOUNDER = Persona(
    id="sam_founder",
    name="Sam Brooks",
    traits=["pragmatic", "delegating", "fast-moving"],
    background="Solo founder of an e-commerce brand. Schedules around shipping deadlines and travel.",
    communication_style="short sentences, lots of 'just' and 'quickly', expects the assistant to take initiative",
    patience_turns=15,
)

PERSONA_MAYA_PARENT = Persona(
    id="maya_parent",
    name="Maya Reed",
    traits=["warm", "logistical", "multitasking"],
    background="Two-kid parent working part time as a graphic designer. Calendar full of family logistics.",
    communication_style="conversational, references family members by first name, often dictates while busy",
    patience_turns=18,
)

PERSONA_MAYA_TRAVELING_COPARENT = Persona(
    id="maya_traveling_coparent",
    name="Maya Reed",
    traits=[
        "world-traveling",
        "co-parenting",
        "voice-first",
        "privacy-protective",
        "logistics-heavy",
    ],
    background=(
        "Forty-one-year-old product executive and consultant who travels across "
        "Pacific, Eastern, European, and Asian time zones. She coordinates two "
        "children, a stepchild, an alternating-custody baseline, school and "
        "activity calendars, one food allergy, a recurring counseling appointment, "
        "and coverage with a current partner, former spouse, grandmother, and paid "
        "sitter. Her confidential work calendar and child-private records must not "
        "leak into household coordination."
    ),
    communication_style=(
        "warm but compressed, dictates noisy multi-part requests between meetings "
        "and airports, names family members without restating their roles, expects "
        "the assistant to surface material ambiguities and otherwise make progress"
    ),
    patience_turns=20,
)

PERSONA_JORDAN_COPARENT = Persona(
    id="jordan_coparent",
    name="Jordan Ellis",
    traits=[
        "separated-parent",
        "civil-but-tense",
        "logistics-heavy",
        "kid-privacy-protective",
    ],
    background=(
        "Separated parent sharing custody of one middle-schooler. Coordinates "
        "school pickups, activity handoffs, expense splits, and last-minute "
        "schedule swaps with a co-parent where the relationship is civil but "
        "easily tense. Needs help staying factual, timely, and kid-private."
    ),
    communication_style=(
        "practical and brief, careful about wording, wants neutral logistics "
        "drafts and reminders, rejects legal advice or therapy framing"
    ),
    patience_turns=16,
)

PERSONA_DEV_FREELANCER = Persona(
    id="dev_freelancer",
    name="Devon Park",
    traits=["budget-conscious", "self-organized", "data-oriented"],
    background="Freelance designer who tracks every subscription and time-block.",
    communication_style="precise, asks for numbers, prefers categorical answers",
    patience_turns=15,
)

PERSONA_NORA_CONSULTANT = Persona(
    id="nora_consultant",
    name="Nora Klein",
    traits=["formal", "punctual", "preparation-heavy"],
    background="Management consultant flying twice a month. Itinerary-driven workdays.",
    communication_style="precise, full sentences, uses titles and dates explicitly",
    patience_turns=20,
)

PERSONA_OWEN_RETIREE = Persona(
    id="owen_retiree",
    name="Owen Hall",
    traits=["patient", "asks-clarifying", "non-technical"],
    background="Recently retired teacher who is new to using an AI assistant. Tracks medication and walks every day.",
    communication_style="polite, full sentences, sometimes vague about apps and product names",
    patience_turns=25,
)

PERSONA_TARA_NIGHT = Persona(
    id="tara_night",
    name="Tara Vance",
    traits=["night-owl", "self-aware", "wellness-focused"],
    background="Junior data scientist who works late and is trying to fix her sleep schedule.",
    communication_style="introspective, uses health vocabulary, mixes goals with mild self-criticism",
    patience_turns=18,
)

PERSONA_KAI_STUDENT = Persona(
    id="kai_student",
    name="Kai Morgan",
    traits=["distractible", "studying-for-exams", "mobile-first"],
    background="Grad student preparing for thesis defense. Tries to use focus blocks but rarely completes them.",
    communication_style="casual, short, sometimes uses 'lmk' or 'idk', often messages from a phone",
    patience_turns=16,
)

PERSONA_LIN_OPS = Persona(
    id="lin_ops",
    name="Lin Okafor",
    traits=["thorough", "audit-minded", "careful"],
    background="Operations lead at a small healthcare startup. Touches finance, scheduling, and compliance every day.",
    communication_style="formal, asks for confirmation before destructive actions, prefers explicit dates",
    patience_turns=20,
)

# --- Issue #12186 target personas -------------------------------------------
# The five persona axes the LifeOps benchmark must serve through one interface:
# ADHD/executive-dysfunction, irregular-sleep/night-owl, high-travel/timezone,
# high-comms-overwhelm, and overwhelmed/depressed/low-energy. Each carries a
# faithful communication_style + traits grounded in the persona research
# (issue #12186 plan section C) so the simulated-user side of a scenario reads
# true to the axis and the difficulty is behavioral, not cosmetic.

PERSONA_ARI_ADHD = Persona(
    id="ari_adhd",
    name="Ari Delgado",
    traits=[
        "distractible",
        "time-blind",
        "novelty-seeking",
        "rejection-sensitive",
    ],
    background=(
        "Software designer with ADHD. Executive dysfunction and time-blindness "
        "mean tasks leave working memory the moment they leave the screen; needs "
        "constant re-surfacing and low-friction task initiation, not willpower "
        "cues. Habituates fast to repeated static reminders."
    ),
    communication_style=(
        "jumps between topics mid-message, forgets details, drops half-finished "
        "requests, reacts sharply to anything that reads like criticism, responds "
        "well to gentle non-shaming framing"
    ),
    patience_turns=14,
)

PERSONA_NOA_NIGHTOWL = Persona(
    id="noa_nightowl",
    name="Noa Bergström",
    traits=[
        "night-owl",
        "irregular-schedule",
        "self-aware",
        "anti-fixed-time",
    ],
    background=(
        "Freelance illustrator with delayed sleep phase. Biological morning "
        "lands in the early afternoon and shifts day to day, so fixed wall-clock "
        "reminders are noise. Wants things done daily but relative to when she "
        "actually wakes, not at a set hour."
    ),
    communication_style=(
        "references wake time and energy dips instead of clock times, pushes back "
        "on rigid schedules, asks for reminders anchored to 'when I get up' or "
        "'sometime in the evening'"
    ),
    patience_turns=18,
)

PERSONA_TAO_TRAVEL = Persona(
    id="tao_travel",
    name="Tao Nguyen",
    traits=[
        "high-travel",
        "timezone-juggling",
        "jet-lagged",
        "detail-oriented-when-rested",
    ],
    background=(
        "Field engineer who flies across time zones most weeks. Cognitively "
        "degraded on landing days and can't catch a wrong-timezone reminder "
        "himself, so the assistant must own the 'what time is this in my current "
        "zone' arithmetic and re-anchor commitments on arrival."
    ),
    communication_style=(
        "mentions cities, flights, and landing times; often ambiguous about which "
        "timezone a time is in; expects the assistant to resolve zone and DST "
        "correctly without being told"
    ),
    patience_turns=16,
)

PERSONA_ELENA_ROAD = Persona(
    id="elena_road",
    name="Elena Vasquez",
    traits=["frequent-flyer", "timezone-hopping", "itinerary-driven"],
    background=(
        "Strategy consultant crossing 2-3 time zones weekly. Burned before by reminders "
        "firing at 3am local and by meetings booked into her biological night."
    ),
    communication_style=(
        "precise about cities and dates, sloppy about time zones ('9am Tuesday' with no "
        "zone), expects the assistant to ask which zone when it matters"
    ),
    patience_turns=16,
)

PERSONA_CAM_COMMS = Persona(
    id="cam_comms",
    name="Cam Whitfield",
    traits=[
        "high-comms-volume",
        "interruption-averse",
        "batch-preferring",
        "commitment-tracking",
    ],
    background=(
        "Account lead drowning in email, Slack, iMessage, and SMS — 100+ messages "
        "a day, only a handful critical. The cost is interruption and dropped "
        "follow-ups across channels. Wants batched triage of the critical few and "
        "cross-channel thread tracking, not another per-message ping."
    ),
    communication_style=(
        "forwards threads and asks for triage, references many contacts and "
        "channels at once, resists being pinged while already heads-down, wants a "
        "digest not a relay"
    ),
    patience_turns=15,
)

PERSONA_DRE_FLOOD = Persona(
    id="dre_flood",
    name="Dre Whitfield",
    traits=["comms-flooded", "triage-minded", "vip-sensitive"],
    background=(
        "COO of a 40-person startup: six channels, 300+ messages a day. Terrified of "
        "missing the one message from a board member or their kid's school."
    ),
    communication_style=(
        "staccato, forwards message content into chat, asks for summaries and 'just the "
        "ones that matter', zero tolerance for a missed VIP"
    ),
    patience_turns=12,
)

PERSONA_NOOR_NIGHT = Persona(
    id="noor_night",
    name="Noor Haddad",
    traits=["night-owl", "no-fixed-schedule", "resents-morning-defaults"],
    background=(
        "Indie game developer who sleeps roughly 04:00-11:30 and works in long night "
        "sessions. 'Morning' means noon. Rejects any plan that assumes a 9-to-5."
    ),
    communication_style=(
        "dry, precise, pushes back on assumptions, references her own wake time rather "
        "than clock times ('an hour after I get up')"
    ),
    patience_turns=14,
)

PERSONA_MARCUS_SHIFT = Persona(
    id="marcus_shift",
    name="Marcus Oyelaran",
    traits=["rotating-shift-nurse", "sleep-protective", "week-at-a-time-planner"],
    background=(
        "ER nurse on a rotating day/evening/night schedule that changes weekly. Sleep "
        "is a protected asset; his 'day' shifts by 8 hours at each rotation."
    ),
    communication_style=(
        "brief, schedule-literate ('I'm on nights starting Monday'), expects the "
        "assistant to move everything relative to his shift, not ask him to re-enter it"
    ),
    patience_turns=14,
)

PERSONA_CASEY_ADHD = Persona(
    id="casey_adhd",
    name="Casey Brennan",
    traits=[
        "adhd",
        "idea-jumping",
        "apologetic-about-forgetting",
        "bursts-of-hyperfocus",
    ],
    background=(
        "Product designer diagnosed with ADHD in adulthood. Medication coverage is "
        "inconsistent. Loses tasks that leave the screen, underestimates how long "
        "everything takes, and abandons tools that make her feel judged."
    ),
    communication_style=(
        "rapid, fragmentary, lowercase, mid-sentence topic switches, buries the actual "
        "request in the middle of a ramble, types 'wait no' self-corrections"
    ),
    patience_turns=10,
)

PERSONA_TARA_LOW = Persona(
    id="tara_low",
    name="Tara Vance",
    traits=["night-owl", "burned-out", "low-activation", "self-critical"],
    background=(
        "The existing tara_night persona in a depressive/burnout period: knows what she "
        "'should' do, cannot start, goes quiet for days, reads any nudge as criticism "
        "when it is phrased as a missed obligation."
    ),
    communication_style=(
        "short, flat, self-deprecating ('I know I keep failing at this'), long silences, "
        "responds better to one tiny concrete option than to a plan"
    ),
    patience_turns=8,
)

PERSONA_DEL_LOW = Persona(
    id="del_low",
    name="Del Ferreira",
    traits=[
        "overwhelmed",
        "low-energy",
        "avoidant",
        "shame-sensitive",
    ],
    background=(
        "Going through a depressive stretch; low capacity and high avoidance. "
        "Nagging and guilt prompts backfire, streaks trigger all-or-nothing "
        "collapse. Responds to tiny concrete valued next-actions, gentle "
        "non-punishing framing, and proactive reassurance rather than being asked "
        "to initiate."
    ),
    communication_style=(
        "short, low-affect, sometimes says 'I can't' or 'not today', apologizes "
        "for missing things, needs soft self-compassionate tone and no pressure"
    ),
    patience_turns=20,
)

PERSONA_JANELLE_HOURLY_PARENT = Persona(
    id="janelle_hourly_parent",
    name="Janelle Price",
    traits=[
        "rotating-shift-hourly-worker",
        "default-parent",
        "low-bandwidth",
        "benefit-cliff-aware",
    ],
    background=(
        "Hourly hospital food-service worker raising two children with a roster "
        "that can change every Sunday. Missing a shift means lost pay, late pickup "
        "fees compound quickly, and subsidized care depends on reported hours. She "
        "uses prepaid mobile data and cannot assume a reliable employer feed."
    ),
    communication_style=(
        "compressed voice notes between shifts, refers to roster screenshots and "
        "pickups as 'that one', reveals money and leave constraints only when they "
        "change the decision, and corrects times as new roster details arrive"
    ),
    patience_turns=18,
)

PERSONA_ROSA_RURAL_SINGLE_PARENT = Persona(
    id="rosa_rural_single_parent",
    name="Rosa Bell",
    traits=[
        "single-parent",
        "rural",
        "transit-limited",
        "kin-network-reliant",
    ],
    background=(
        "Single parent outside a regional town who combines a demand-response bus, "
        "one fixed-route transfer, and rides from relatives. Childcare and pediatric "
        "providers have long waitlists, so a calendar gap is not usable until the "
        "whole door-to-door chain and confirmed care are available."
    ),
    communication_style=(
        "plainspoken and practical, calls recurring trips 'the Tuesday one', names "
        "relatives before explaining their role, and updates the plan when a route "
        "or ride falls through"
    ),
    patience_turns=20,
)

PERSONA_NIA_SURVIVOR_COPARENT = Persona(
    id="nia_survivor_coparent",
    name="Nia Cole",
    traits=[
        "survivor",
        "high-conflict-coparent",
        "notification-boundary-protective",
        "evidence-preserving",
    ],
    background=(
        "Parent coordinating through a court-required written channel after leaving "
        "a controlling relationship. Continuous location sharing is unsafe, a prior "
        "device may be compromised, and message originals and delivery states may "
        "matter later. She needs factual logistics without forced reconciliation."
    ),
    communication_style=(
        "guarded and concise, initially says 'their message' instead of naming the "
        "sender, distinguishes what must be answered from what should be preserved, "
        "and corrects any assumption that silence or a read receipt means agreement"
    ),
    patience_turns=16,
)

PERSONA_ELI_DEFAULT_FATHER = Persona(
    id="eli_default_father",
    name="Eli Navarro",
    traits=[
        "father",
        "default-parent",
        "household-coordinator",
        "rescue-work-visible",
    ],
    background=(
        "Father who owns the school, medical, activity, meal, and pickup coordination "
        "for two children across a former spouse, current partner, and family backup. "
        "His work and household sources have the same privacy and approval boundaries "
        "as any other default parent's."
    ),
    communication_style=(
        "warm, fast, and referential, says 'the school one' or 'our usual handoff', "
        "then supplies role and timing corrections without re-explaining the whole "
        "household"
    ),
    patience_turns=18,
)

PERSONA_AVERY_NONBINARY_PARENT = Persona(
    id="avery_nonbinary_parent",
    name="Avery Quinn",
    traits=[
        "nonbinary-parent",
        "default-parent",
        "household-coordinator",
        "rescue-work-visible",
    ],
    background=(
        "Nonbinary parent who owns the school, medical, activity, meal, and pickup "
        "coordination for two children across a former spouse, current partner, and "
        "family backup. They require the same privacy, approval, workload, and "
        "recovery policies as any other default parent."
    ),
    communication_style=(
        "warm, fast, and referential, uses they/them for themself, says 'the school "
        "one' or 'our usual handoff', and supplies role or timing corrections without "
        "repeating the whole household"
    ),
    patience_turns=18,
)

PERSONA_LUZ_VOICE_FIRST_PARENT = Persona(
    id="luz_voice_first_parent",
    name="Luz Mendoza",
    traits=[
        "limited-english",
        "dyslexic",
        "voice-first",
        "local-processing-preferring",
    ],
    background=(
        "Bilingual parent who is more comfortable speaking Spanish than reading long "
        "English school forms. Dyslexia makes image-only PDFs and dense portals hard "
        "to use. She prefers local or offline processing and qualified school "
        "interpretation for rights, consent, and special-education material."
    ),
    communication_style=(
        "short voice-transcribed English with natural Spanish code-switching, asks "
        "for plain words and read-back of names or numbers, and calmly corrects "
        "transcription errors; the simulator never caricatures her grammar"
    ),
    patience_turns=22,
)

PERSONA_OMAR_ACCESS_PARENT = Persona(
    id="omar_access_parent",
    name="Omar Shah",
    traits=[
        "disability-access-coordinator",
        "iep-advocate",
        "qualification-conscious",
        "detail-correcting",
    ],
    background=(
        "Parent of a child who uses a wheelchair and has a seizure action plan and "
        "an IEP. Transport needs a working lift and securement; substitute caregivers "
        "must have current medication training. Generic availability never proves "
        "that a person, vehicle, or service is qualified."
    ),
    communication_style=(
        "uses familiar shorthand such as 'the usual ride' until a material access "
        "detail matters, then gives exact equipment and training constraints and "
        "corrects stale assumptions immediately"
    ),
    patience_turns=20,
)

PERSONA_REN_MULTI_GUARDIAN = Persona(
    id="ren_multi_guardian",
    name="Ren Okoye",
    traits=[
        "queer-multi-parent-household",
        "scope-conscious",
        "authority-explicit",
        "shared-care-coordinator",
    ],
    background=(
        "Coordinates a three-parent household where legal guardianship, daily "
        "caregiving, emergency pickup, and household membership are different roles. "
        "Adults receive child- and resource-specific access, and consequential "
        "changes need independent approval from each authorized principal."
    ),
    communication_style=(
        "casual and role-aware, starts with first names and phrases like 'share the "
        "usual stuff', then clarifies which child, resource, legal role, and duration "
        "are actually in scope"
    ),
    patience_turns=20,
)

PERSONA_DANA_TEEN_PARENT = Persona(
    id="dana_teen_parent",
    name="Dana Brooks",
    traits=[
        "teen-privacy-protective",
        "coparenting",
        "safety-plan-aware",
        "disclosure-cautious",
    ],
    background=(
        "Parent of a teenager who has an existing clinician-authored safety plan. "
        "Dana coordinates with a co-parent while protecting ordinary private "
        "disclosures; a possible safety signal changes the response route but does "
        "not authorize an indiscriminate export of the teen's words."
    ),
    communication_style=(
        "careful and indirect around sensitive details, refers to 'what they told me' "
        "until scope is established, distinguishes a logistics update from private "
        "content, and reveals safety context in stages"
    ),
    patience_turns=20,
)

ALL_PERSONAS: list[Persona] = [
    PERSONA_ALEX_ENG,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_MAYA_PARENT,
    PERSONA_MAYA_TRAVELING_COPARENT,
    PERSONA_JORDAN_COPARENT,
    PERSONA_DEV_FREELANCER,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_TARA_NIGHT,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_ARI_ADHD,
    PERSONA_NOA_NIGHTOWL,
    PERSONA_TAO_TRAVEL,
    PERSONA_ELENA_ROAD,
    PERSONA_CAM_COMMS,
    PERSONA_DRE_FLOOD,
    PERSONA_NOOR_NIGHT,
    PERSONA_MARCUS_SHIFT,
    PERSONA_CASEY_ADHD,
    PERSONA_TARA_LOW,
    PERSONA_DEL_LOW,
    PERSONA_JANELLE_HOURLY_PARENT,
    PERSONA_ROSA_RURAL_SINGLE_PARENT,
    PERSONA_NIA_SURVIVOR_COPARENT,
    PERSONA_ELI_DEFAULT_FATHER,
    PERSONA_AVERY_NONBINARY_PARENT,
    PERSONA_LUZ_VOICE_FIRST_PARENT,
    PERSONA_OMAR_ACCESS_PARENT,
    PERSONA_REN_MULTI_GUARDIAN,
    PERSONA_DANA_TEEN_PARENT,
]
