"""Rule-based synthesis of (prompt template / action) → eliza records.

Generates ~50k synthetic native format training records targeting the
elizaOS-native prompt/action surface that is currently uncovered by the
real corpora. Inputs:

  - data/prompts/registry-v2.json   (482 prompts: core, plugin, lifeops,
                                     inline-action)
  - data/prompts/actions-catalog.json (111 plugin actions)

Outputs (jsonl, one record per line; flat eliza shape per SCHEMA.md):

  data/synthesized/action_pairs/core-prompts.jsonl
  data/synthesized/action_pairs/plugin-prompts.jsonl
  data/synthesized/action_pairs/lifeops.jsonl
  data/synthesized/action_pairs/actions-catalog.jsonl

Strategy: rule-based — no LLM API key required. Per template we sample a
small pool of canned domain scenarios, paraphrase the user message
linguistically, and synthesize a native JSON expectedResponse populated from the
template's expected_keys. For action-catalog records we emit a native JSON
`tool_calls[N]` envelope with a `TASK_CALL` availableAction.

Run:
    .venv/bin/python scripts/synthesize_action_pairs.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_RESPOND,
    ACTION_STOP,
    ACTION_TASK_CALL,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

REGISTRY_PATH = ROOT / "data" / "prompts" / "registry-v2.json"
ACTIONS_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
OUT_DIR = ROOT / "data" / "synthesized" / "action_pairs"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-pairs")


# ───────────────────────────── shared pools ─────────────────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "eliza", "Eliza",
]

USER_NAMES = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas",
]

ROOM_KINDS = ["dm", "channel:general", "channel:engineering", "channel:design",
              "channel:trading", "channel:ops", "channel:announcements"]

CHANNELS = ["dm", "public", "voice"]


# ───────────────────────────── core scenario pools ──────────────────────

# Each pool is a list of dicts. The values are canonical scenario fields;
# templates pick whichever keys they need.

CONTACT_SCENARIOS = [
    {"contactName": "Jane Doe", "entityId": "ent-jane-001", "categories": "vip,colleague",
     "notes": "Met at the design summit", "timezone": "America/New_York", "language": "English",
     "reason": "Important collaborator to remember"},
    {"contactName": "Pierre Lemoine", "entityId": "", "categories": "client",
     "notes": "Interested in quarterly review", "timezone": "Europe/Paris", "language": "French",
     "reason": "Active sales lead"},
    {"contactName": "Aiko Tanaka", "entityId": "ent-aiko-22", "categories": "investor",
     "notes": "Backed seed round", "timezone": "Asia/Tokyo", "language": "Japanese",
     "reason": "Requires quarterly investor update"},
    {"contactName": "Mateo Rivera", "entityId": "", "categories": "candidate,engineer",
     "notes": "Senior backend, looped in by recruiter", "timezone": "America/Mexico_City",
     "language": "Spanish", "reason": "Open hiring loop"},
    {"contactName": "Priya Patel", "entityId": "", "categories": "advisor",
     "notes": "Helps with go-to-market strategy", "timezone": "Asia/Kolkata",
     "language": "English", "reason": "Recurring advisory cadence"},
    {"contactName": "Eitan Cohen", "entityId": "ent-eitan", "categories": "designer,colleague",
     "notes": "Lead on the iOS redesign", "timezone": "Asia/Jerusalem", "language": "Hebrew",
     "reason": "Cross-functional collaborator"},
    {"contactName": "Nadia Haddad", "entityId": "", "categories": "press",
     "notes": "Tech reporter, covered launch", "timezone": "Europe/Beirut", "language": "Arabic",
     "reason": "Press relationship to maintain"},
    {"contactName": "Wei Chen", "entityId": "ent-wei", "categories": "vendor",
     "notes": "Supplies our office hardware", "timezone": "Asia/Shanghai", "language": "Mandarin",
     "reason": "Logistics contact"},
    {"contactName": "Sven Nielsen", "entityId": "", "categories": "friend",
     "notes": "Old roommate, lives in Copenhagen now", "timezone": "Europe/Copenhagen",
     "language": "Danish", "reason": "Personal contact, periodic catch-ups"},
    {"contactName": "Carla Reyes", "entityId": "ent-carla", "categories": "customer,early-access",
     "notes": "Beta tester, very vocal", "timezone": "America/Los_Angeles", "language": "English",
     "reason": "Power user we want to retain"},
    {"contactName": "Lukas Becker", "entityId": "", "categories": "investor,board",
     "notes": "Series A lead, board observer", "timezone": "Europe/Berlin", "language": "German",
     "reason": "Board governance"},
    {"contactName": "Aminata Diallo", "entityId": "", "categories": "partner",
     "notes": "Runs nonprofit partner org", "timezone": "Africa/Dakar", "language": "French",
     "reason": "Strategic partnership"},
    {"contactName": "Ren Park", "entityId": "ent-ren", "categories": "candidate,intern",
     "notes": "Top of intern shortlist", "timezone": "Asia/Seoul", "language": "Korean",
     "reason": "Intern hiring loop"},
    {"contactName": "Marisol Vargas", "entityId": "", "categories": "client,enterprise",
     "notes": "Procurement contact at Acme", "timezone": "America/Bogota", "language": "Spanish",
     "reason": "Active enterprise deal"},
    {"contactName": "Evren Yilmaz", "entityId": "", "categories": "colleague",
     "notes": "Joined the data infra team last month", "timezone": "Europe/Istanbul",
     "language": "Turkish", "reason": "New teammate to remember"},
    {"contactName": "Hiroshi Sato", "entityId": "ent-hiro", "categories": "mentor",
     "notes": "Former manager, still consults", "timezone": "Asia/Tokyo", "language": "Japanese",
     "reason": "Career mentor"},
    {"contactName": "Olamide Bello", "entityId": "", "categories": "candidate",
     "notes": "Strong frontend portfolio", "timezone": "Africa/Lagos", "language": "English",
     "reason": "Frontend hire candidate"},
    {"contactName": "Anastasia Volkov", "entityId": "", "categories": "vendor,legal",
     "notes": "Outside counsel for IP", "timezone": "Europe/Moscow", "language": "Russian",
     "reason": "Active legal matter"},
    {"contactName": "Fatima al-Sayed", "entityId": "ent-fatima", "categories": "vip,executive",
     "notes": "CTO of partner company", "timezone": "Asia/Dubai", "language": "Arabic",
     "reason": "Exec relationship"},
    {"contactName": "Diego Souza", "entityId": "", "categories": "freelancer,designer",
     "notes": "Did our brand refresh", "timezone": "America/Sao_Paulo", "language": "Portuguese",
     "reason": "Past contractor, may rehire"},
]

ROOM_DECISION_SCENARIOS = [
    {"room": "#design-crit", "reason": "noise too high — 200+ msgs/day, mostly off-topic for me"},
    {"room": "#trading-floor", "reason": "I want to lurk and learn but not respond"},
    {"room": "#general", "reason": "everyone is welcome, I should stay engaged"},
    {"room": "#announcements", "reason": "broadcast channel, no point me replying"},
    {"room": "#engineering", "reason": "core channel, always follow"},
    {"room": "#random", "reason": "casual chatter, opt out"},
    {"room": "#standup", "reason": "structured updates only, mute notifications"},
    {"room": "#alerts", "reason": "monitor only, don't post"},
    {"room": "#deals", "reason": "deal flow channel, follow closely"},
    {"room": "#offtopic", "reason": "low-signal banter"},
    {"room": "#help-desk", "reason": "support flow — must respond"},
    {"room": "#hiring", "reason": "I want to track candidates"},
    {"room": "#leadership", "reason": "executive context, follow"},
    {"room": "#bots-test", "reason": "test channel, mute"},
    {"room": "#localized-jp", "reason": "japanese-only conversation, not my language"},
]

DECISION_REASONS = [
    "the conversation is off-topic for my role",
    "this room is too noisy for productive engagement",
    "I want to stay informed but not participate actively",
    "this channel is critical to my function and I should follow",
    "I have been explicitly invited to participate here",
    "my last 5 messages here got no reaction — pulling back",
    "the room owner asked me to lurk only",
    "I keep getting paged here for things outside my scope",
    "the team wants me re-engaged after a quiet period",
    "the user explicitly asked me to step back",
]

OPTION_SCENARIOS = [
    {"options": ["pizza", "sushi", "tacos"], "selected": "sushi", "reason": "the team voted sushi 4-1 last week"},
    {"options": ["red", "blue", "green"], "selected": "blue", "reason": "blue matches our brand palette"},
    {"options": ["ship-now", "ship-tomorrow", "delay-week"], "selected": "ship-tomorrow",
     "reason": "we still need a final QA pass overnight"},
    {"options": ["accept", "counter", "reject"], "selected": "counter",
     "reason": "the offer is close but undervalues equity"},
    {"options": ["aws", "gcp", "fly.io"], "selected": "fly.io",
     "reason": "edge deploys are critical for this workload"},
    {"options": ["hire-senior", "hire-mid", "hire-two-juniors"], "selected": "hire-senior",
     "reason": "we need autonomous ownership of the data infra"},
    {"options": ["v1", "v2", "v3"], "selected": "v3", "reason": "v3 has the canonical schema we agreed on"},
    {"options": ["postpone", "proceed", "cancel"], "selected": "proceed",
     "reason": "blocking issues are resolved and stakeholders are aligned"},
    {"options": ["typescript", "rust", "go"], "selected": "typescript",
     "reason": "rest of the codebase is typescript and team velocity matters"},
    {"options": ["weekly", "biweekly", "monthly"], "selected": "biweekly",
     "reason": "weekly is too noisy, monthly loses momentum"},
]

SUMMARY_SCENARIOS = [
    {
        "topics": ["product roadmap", "Q2 hiring", "infra cost"],
        "keyPoints": ["Roadmap focused on retention features", "Hiring slowed for runway",
                      "Migrating cold storage to R2 for cost"],
        "summary": "Discussed Q2 priorities: retention features lead the roadmap, hiring is paused, and we're migrating cold storage to R2 to cut infra cost."
    },
    {
        "topics": ["incident postmortem", "alerting gaps", "on-call rotation"],
        "keyPoints": ["Root cause was a stale TLS cert", "Alerts fired 40 min late",
                      "On-call rotation will rebalance"],
        "summary": "Postmortem on the auth outage: stale TLS cert, alerting was 40 minutes late, on-call rotation will be rebalanced."
    },
    {
        "topics": ["fundraising", "valuation", "term sheet"],
        "keyPoints": ["Two term sheets in hand", "Valuation range narrowed", "Decision by Friday"],
        "summary": "Two term sheets received with overlapping valuation range; founder team will pick by Friday."
    },
    {
        "topics": ["design review", "iOS redesign", "accessibility"],
        "keyPoints": ["New tab bar approved", "Color contrast fails on 3 screens", "Re-review next Tuesday"],
        "summary": "iOS redesign approved with conditions; three accessibility regressions to fix before re-review Tuesday."
    },
    {
        "topics": ["customer call", "Acme renewal", "expansion"],
        "keyPoints": ["Acme renewing at 1.5x", "Wants SSO and audit logs", "Decision in two weeks"],
        "summary": "Acme renewing at 1.5x current contract; need SSO and audit logs to close. They decide in two weeks."
    },
]

FOLLOWUP_SCENARIOS = [
    {"contactName": "Jane Doe", "entityId": "ent-jane-001",
     "message": "Following up on our design summit conversation — let me know if next Tuesday works.",
     "priority": "medium", "scheduledAt": "2026-05-09T10:00:00-04:00",
     "reason": "Promised to circle back about a follow-up call."},
    {"contactName": "Lukas Becker", "entityId": "",
     "message": "Quarterly board update for your review.",
     "priority": "high", "scheduledAt": "2026-06-30T15:00:00+02:00",
     "reason": "Board update cadence."},
    {"contactName": "Carla Reyes", "entityId": "ent-carla",
     "message": "Beta feedback survey — would love your take.",
     "priority": "low", "scheduledAt": "2026-05-15T09:00:00-07:00",
     "reason": "Beta retention loop."},
    {"contactName": "Marisol Vargas", "entityId": "",
     "message": "Procurement docs for the Acme contract — ping me if anything is missing.",
     "priority": "high", "scheduledAt": "2026-05-05T11:00:00-05:00",
     "reason": "Active enterprise deal pacing."},
    {"contactName": "Hiroshi Sato", "entityId": "ent-hiro",
     "message": "Quarterly career check-in — does next week work?",
     "priority": "low", "scheduledAt": "2026-07-01T18:00:00+09:00",
     "reason": "Mentor cadence."},
    {"contactName": "Aminata Diallo", "entityId": "",
     "message": "Touching base on partnership milestones for H2.",
     "priority": "medium", "scheduledAt": "2026-06-15T10:00:00+00:00",
     "reason": "Partnership cadence."},
]

SEARCH_CONTACT_SCENARIOS = [
    {"intent": "find vendor for office hardware", "searchTerm": "Wei Chen",
     "categories": "vendor", "tags": "hardware,office"},
    {"intent": "list all investors", "searchTerm": "", "categories": "investor", "tags": ""},
    {"intent": "japanese clients", "searchTerm": "", "categories": "client", "tags": "japanese,jp"},
    {"intent": "advisor recommendations on go-to-market", "searchTerm": "Priya Patel",
     "categories": "advisor", "tags": "gtm,strategy"},
    {"intent": "press contacts in Lebanon", "searchTerm": "", "categories": "press", "tags": "press,middle-east"},
    {"intent": "intern shortlist", "searchTerm": "", "categories": "candidate,intern", "tags": "intern,2026"},
    {"intent": "find the designer who did our brand refresh", "searchTerm": "Diego Souza",
     "categories": "designer,freelancer", "tags": "branding"},
    {"intent": "all VIPs", "searchTerm": "", "categories": "vip", "tags": ""},
    {"intent": "candidates from Korean market", "searchTerm": "", "categories": "candidate", "tags": "kr,korea"},
    {"intent": "personal friends in Europe", "searchTerm": "", "categories": "friend", "tags": "europe,personal"},
]

UPDATE_CONTACT_SCENARIOS = [
    {"contactName": "Jane Doe", "operation": "merge", "categories": "vip,advisor",
     "tags": "design,executive", "notes": "Promoted to VP of Design",
     "preferences": "prefers async over meetings",
     "customFields": "linkedin=jane-doe"},
    {"contactName": "Carla Reyes", "operation": "set", "categories": "customer,enterprise",
     "tags": "early-access,vocal", "notes": "Now in our top 10 ARR accounts",
     "preferences": "weekly check-ins",
     "customFields": "tier=platinum"},
    {"contactName": "Mateo Rivera", "operation": "merge", "categories": "engineer",
     "tags": "backend,distributed-systems", "notes": "Accepted offer",
     "preferences": "prefers Slack",
     "customFields": "start_date=2026-06-01"},
    {"contactName": "Priya Patel", "operation": "remove", "categories": "advisor",
     "tags": "", "notes": "Stepping down from advisor role",
     "preferences": "",
     "customFields": ""},
    {"contactName": "Anastasia Volkov", "operation": "set", "categories": "vendor,legal",
     "tags": "ip,active", "notes": "New retainer signed Q2",
     "preferences": "email-only",
     "customFields": "firm=VK Partners"},
]

ROLE_SCENARIOS = [
    {"entity_id": "ent-jane-001", "new_role": "admin", "thought": "Promoted to ops lead, needs admin access."},
    {"entity_id": "ent-mateo", "new_role": "engineer", "thought": "Accepted offer, granting engineer role."},
    {"entity_id": "ent-carla", "new_role": "early-access", "thought": "Power user, granting early-access role."},
    {"entity_id": "ent-lukas", "new_role": "board-observer", "thought": "Series A lead joins as observer."},
    {"entity_id": "ent-priya", "new_role": "viewer", "thought": "Stepping down from advisor, downgrading."},
    {"entity_id": "ent-evren", "new_role": "data-eng", "thought": "Joined data infra team."},
    {"entity_id": "ent-hiro", "new_role": "mentor", "thought": "Continuing mentor relationship."},
    {"entity_id": "ent-fatima", "new_role": "partner-exec", "thought": "Partner-org CTO, exec role."},
    {"entity_id": "ent-ren", "new_role": "intern", "thought": "Summer intern, intern role."},
    {"entity_id": "ent-wei", "new_role": "vendor", "thought": "Hardware vendor."},
]

REMOVE_CONTACT_SCENARIOS = [
    {"contactName": "Jane Doe", "confirmed": True},
    {"contactName": "Pierre Lemoine", "confirmed": False},
    {"contactName": "Sven Nielsen", "confirmed": True},
    {"contactName": "Diego Souza", "confirmed": False},
    {"contactName": "Wei Chen", "confirmed": True},
    {"contactName": "Olamide Bello", "confirmed": True},
]

THINK_TOPICS = [
    "what's the cheapest path to ship the new auth flow",
    "how to balance the on-call rotation now that Mei is on leave",
    "whether to accept the term sheet from Lukas's fund",
    "if the iOS redesign should ship before WWDC",
    "rationale for picking R2 over S3 cold storage",
    "whether the memo should mention the price increase",
    "how to phrase the rejection to the candidate",
    "if the standup should move to async",
]


# ───────────────────────────── paraphrase helpers ───────────────────────

def paraphrase_user_msg(scenario_text: str, idx: int, rng: random.Random) -> str:
    """Return one of N linguistic variants of scenario_text."""
    variants = [
        scenario_text,
        f"hey, {scenario_text.lower()}",
        f"please {scenario_text.lower()}",
        f"can you {scenario_text.lower()}",
        f"could you handle this — {scenario_text.lower()}",
        f"quick one: {scenario_text.lower()}",
        f"{scenario_text} thanks!",
        f"{scenario_text} (urgent)",
        f"FYI: {scenario_text}",
        f"todo: {scenario_text.lower()}",
    ]
    return variants[idx % len(variants)]


def paraphrase_keep_meaning(base: str, idx: int) -> str:
    """5 linguistic forms of base string, returned by idx."""
    forms = [
        base,
        base.replace(".", "") + ", please",
        f"could you {base[0].lower() + base[1:]}",
        f"need to {base[0].lower() + base[1:]}",
        f"{base} — when you have a sec",
    ]
    return forms[idx % len(forms)]


def random_room_meta(rng: random.Random) -> tuple[str, str]:
    return rng.choice(ROOM_KINDS), rng.choice(CHANNELS)


# ───────────────────────────── builders per template ────────────────────

def build_record(
    *,
    encoder: ExpectedResponseEncoder,
    task_id: str,
    user_msg: str,
    expected: dict[str, Any] | str,
    available_actions: list[str],
    source_dataset: str,
    extra_md: dict[str, Any] | None = None,
    rng: random.Random,
) -> dict[str, Any]:
    """Common envelope for synthesized records."""
    agent = rng.choice(AGENT_NAMES)
    user = rng.choice(USER_NAMES)
    room, channel = random_room_meta(rng)

    if isinstance(expected, str):
        expected_str = expected
    else:
        expected_str = encoder.encode(expected)

    md = {"agent_name": agent}
    if extra_md:
        md.update(extra_md)

    rec = build(
        roomName=stable_id("synth-action-pairs", task_id, user_msg, agent),
        agentId=agent.lower(),
        memoryEntries=[],
        currentMessage={
            "role": "user",
            "speaker": user,
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=available_actions,
        task_type=task_id,
        source_dataset=source_dataset,
        license="synthetic",
        split="train",
        extra_metadata=md,
    )
    return rec.to_dict()


# ─── core templates ────────────────────────────────────────────────────

def gen_add_contact(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "save {name} to my contacts — {notes}",
        "add {name}, {categories} please",
        "remind me about {name}, they're {categories}",
        "let's keep {name} in my contacts. {notes}",
        "create a contact for {name} — they speak {language}",
    ]
    for i in range(n):
        sc = CONTACT_SCENARIOS[i % len(CONTACT_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(
            name=sc["contactName"],
            categories=sc["categories"].replace(",", " and "),
            notes=sc["notes"].lower(),
            language=sc["language"],
        )
        expected = {
            "contactName": sc["contactName"],
            "entityId": sc.get("entityId", ""),
            "categories": sc["categories"],
            "notes": sc["notes"],
            "timezone": sc["timezone"],
            "language": sc["language"],
            "reason": sc["reason"],
        }
        yield build_record(
            encoder=encoder, task_id="add_contact", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
            extra_md={"scenario_idx": i % len(CONTACT_SCENARIOS)},
        )


def gen_remove_contact(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "remove {name} from my contacts",
        "delete the contact for {name}",
        "drop {name} please — no longer relevant",
        "yes, confirm: remove {name}",
        "wait, don't remove {name} after all",
    ]
    for i in range(n):
        sc = REMOVE_CONTACT_SCENARIOS[i % len(REMOVE_CONTACT_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(name=sc["contactName"])
        # If 'wait, don't remove' phrasing, override confirmed=False
        confirmed = sc["confirmed"] if "wait" not in msg else False
        expected = {
            "contactName": sc["contactName"],
            "confirmed": confirmed,
        }
        yield build_record(
            encoder=encoder, task_id="remove_contact", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_search_contacts(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "find me contacts that match: {intent}",
        "search contacts — {intent}",
        "who do I know that fits this: {intent}",
        "list contacts: {intent}",
        "pull up my {categories} list — {intent}",
    ]
    for i in range(n):
        sc = SEARCH_CONTACT_SCENARIOS[i % len(SEARCH_CONTACT_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(
            intent=sc["intent"],
            categories=sc["categories"] or "all",
        )
        expected = {
            "intent": sc["intent"],
            "searchTerm": sc["searchTerm"],
            "categories": sc["categories"],
            "tags": sc["tags"],
        }
        yield build_record(
            encoder=encoder, task_id="search_contacts", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_schedule_follow_up(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "schedule a follow-up with {name}: {message}",
        "remind me to ping {name} — {message}",
        "queue a follow-up for {name} on {scheduledAt}",
        "set a {priority} priority follow-up with {name}",
        "follow up with {name} re: {message}",
    ]
    for i in range(n):
        sc = FOLLOWUP_SCENARIOS[i % len(FOLLOWUP_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(
            name=sc["contactName"], message=sc["message"],
            priority=sc["priority"], scheduledAt=sc["scheduledAt"],
        )
        expected = {
            "contactName": sc["contactName"],
            "entityId": sc["entityId"],
            "message": sc["message"],
            "priority": sc["priority"],
            "scheduledAt": sc["scheduledAt"],
            "reason": sc["reason"],
        }
        yield build_record(
            encoder=encoder, task_id="schedule_follow_up", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_update_contact(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "update {name}'s contact info — notes: {notes}",
        "change {name}'s categories to {categories}",
        "{name} now prefers {preferences}",
        "tag {name} with {tags}",
        "remove the {tags} tag from {name}",
    ]
    for i in range(n):
        sc = UPDATE_CONTACT_SCENARIOS[i % len(UPDATE_CONTACT_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(
            name=sc["contactName"], notes=sc["notes"], categories=sc["categories"],
            preferences=sc["preferences"] or "no specific channel",
            tags=sc["tags"] or "no-tag",
        )
        expected = {
            "contactName": sc["contactName"],
            "operation": sc["operation"],
            "categories": sc["categories"],
            "tags": sc["tags"],
            "notes": sc["notes"],
            "preferences": sc["preferences"],
            "customFields": sc["customFields"],
        }
        yield build_record(
            encoder=encoder, task_id="update_contact", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_update_role(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "promote {entity_id} to {new_role}",
        "set {entity_id}'s role to {new_role}",
        "{entity_id} should be {new_role} now",
        "update role: {entity_id} → {new_role}",
        "grant {new_role} access to {entity_id}",
    ]
    for i in range(n):
        sc = ROLE_SCENARIOS[i % len(ROLE_SCENARIOS)]
        msg = phrasings[i % len(phrasings)].format(
            entity_id=sc["entity_id"], new_role=sc["new_role"],
        )
        expected = {
            "entity_id": sc["entity_id"],
            "new_role": sc["new_role"],
            "thought": sc["thought"],
        }
        yield build_record(
            encoder=encoder, task_id="update_role", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_should_room(encoder: ExpectedResponseEncoder, rng: random.Random, n: int,
                    task_id: str) -> Iterable[dict]:
    """Shared generator for should_{mute,unmute,follow,unfollow}_room."""
    yes_phrasings_mute = ["mute {room}", "silence {room}", "shush {room}"]
    yes_phrasings_unmute = ["unmute {room}", "start listening to {room} again"]
    yes_phrasings_follow = ["follow {room}", "join {room} actively", "stay engaged with {room}"]
    yes_phrasings_unfollow = ["unfollow {room}", "step back from {room}", "leave {room}"]

    no_phrasings = [
        "don't change anything about {room}",
        "leave {room} as it is",
        "skip — keep {room} unchanged",
    ]
    if task_id == "should_mute_room":
        yes_pool = yes_phrasings_mute
    elif task_id == "should_unmute_room":
        yes_pool = yes_phrasings_unmute
    elif task_id == "should_follow_room":
        yes_pool = yes_phrasings_follow
    else:  # should_unfollow_room
        yes_pool = yes_phrasings_unfollow

    for i in range(n):
        sc = ROOM_DECISION_SCENARIOS[i % len(ROOM_DECISION_SCENARIOS)]
        # 75% yes, 25% no
        if (i * 13 + 7) % 4 == 0:
            msg = no_phrasings[i % len(no_phrasings)].format(room=sc["room"])
            decision = False
        else:
            msg = yes_pool[i % len(yes_pool)].format(room=sc["room"])
            decision = True
        expected = {"decision": decision}
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_should_respond(encoder: ExpectedResponseEncoder, rng: random.Random, n: int,
                       with_context: bool) -> Iterable[dict]:
    task_id = "should_respond_with_context" if with_context else "should_respond"
    contexts = ["wallet", "scheduling", "incident-response", "fundraising",
                "design-review", "general", "support", "personal"]
    actions_cycle = [ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP]
    msg_templates = {
        ACTION_RESPOND: [
            "@{agent} can you take this?",
            "{agent}, what do you think about this?",
            "hey {agent}, quick one for you",
            "would love your input here {agent}",
            "{agent} I need your help",
        ],
        ACTION_IGNORE: [
            "ok, see you later",
            "thanks team",
            "I'll handle this myself",
            "no need to reply",
            "just thinking out loud",
        ],
        ACTION_STOP: [
            "stop pinging me {agent}",
            "{agent} please be quiet",
            "go away {agent}",
            "{agent} stop responding",
            "I asked you to stop, {agent}",
        ],
    }
    for i in range(n):
        action = actions_cycle[i % 3]
        agent = rng.choice(AGENT_NAMES)
        msg = msg_templates[action][i % len(msg_templates[action])].format(agent=agent)
        ctx = contexts[i % len(contexts)]
        expected = {
            "name": agent,
            "reasoning": {
                ACTION_RESPOND: f"the message is directly addressed to {agent}",
                ACTION_IGNORE: "the user is not addressing the agent",
                ACTION_STOP: "the user explicitly asked the agent to stop",
            }[action],
            "action": action,
            "primaryContext": ctx,
            "secondaryContexts": "",
        }
        if not with_context:
            expected["evidenceTurnIds"] = ""
        # Build directly because we want explicit agent (not random)
        room, channel = random_room_meta(rng)
        rec = build(
            roomName=stable_id("synth-action-pairs", task_id, msg, agent, action),
            agentId=agent.lower(),
            memoryEntries=[],
            currentMessage={"role": "user", "speaker": rng.choice(USER_NAMES),
                            "content": msg, "channel": channel},
            expectedResponse=encoder.encode(expected),
            availableActions=[ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP],
            task_type=task_id,
            source_dataset="synth-action-pairs-core",
            license="synthetic",
            split="train",
            extra_metadata={"agent_name": agent, "synth_target_action": action},
        )
        yield rec.to_dict()


def gen_choose_option(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "pick one: {options}",
        "we need a decision — {options}",
        "from these: {options}, which?",
        "{options} — your call",
        "choose: {options}",
    ]
    for i in range(n):
        sc = OPTION_SCENARIOS[i % len(OPTION_SCENARIOS)]
        opts_str = ", ".join(sc["options"])
        msg = phrasings[i % len(phrasings)].format(options=opts_str)
        expected = {
            "thought": sc["reason"],
            "selected_id": sc["selected"],
        }
        yield build_record(
            encoder=encoder, task_id="choose_option", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_option_extraction(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "the available options are: {options}. We need to pick.",
        "from the meeting: choices are {options}",
        "options today: {options}",
        "{options} — these are the options on the table",
        "summarize the options: {options}",
    ]
    for i in range(n):
        sc = OPTION_SCENARIOS[i % len(OPTION_SCENARIOS)]
        opts_str = ", ".join(sc["options"])
        msg = phrasings[i % len(phrasings)].format(options=opts_str)
        # Each option becomes a separate field
        expected: dict[str, Any] = {}
        for j, opt in enumerate(sc["options"]):
            expected[f"option_{j}"] = opt
        expected["count"] = len(sc["options"])
        yield build_record(
            encoder=encoder, task_id="option_extraction", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_reflection(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "reflect on the last conversation",
        "summarize what just happened and what you learned",
        "what was the takeaway from that exchange",
        "give me your reflection on today's standup",
        "what did you learn from the customer call",
    ]
    for i in range(n):
        sc = SUMMARY_SCENARIOS[i % len(SUMMARY_SCENARIOS)]
        msg = phrasings[i % len(phrasings)]
        expected = {
            "thought": f"Reflecting on {', '.join(sc['topics'])}",
            "summary": sc["summary"],
            "keyInsight": sc["keyPoints"][0],
        }
        yield build_record(
            encoder=encoder, task_id="reflection", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_reflection_evaluator(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "evaluate that last reflection",
        "score the previous summary on quality",
        "is the reflection useful?",
        "rate the assistant's last response",
        "give feedback on the summary",
    ]
    for i in range(n):
        msg = phrasings[i % len(phrasings)]
        expected = {
            "score": [0.7, 0.85, 0.6, 0.9, 0.75][i % 5],
            "feedback": [
                "Reflection is concise and actionable.",
                "Good coverage of the main topics, slightly long.",
                "Missing the action items from the discussion.",
                "Strong reflection with clear next steps.",
                "Solid summary, could include more specifics.",
            ][i % 5],
        }
        yield build_record(
            encoder=encoder, task_id="reflection_evaluator", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_think(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    for i in range(n):
        topic = THINK_TOPICS[i % len(THINK_TOPICS)]
        msg = f"think about {topic}"
        expected = {
            "thought": f"Considering: {topic}. Need to weigh trade-offs and pick a clear next step.",
        }
        yield build_record(
            encoder=encoder, task_id="think", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_initial_summarization(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "summarize the conversation so far",
        "give me a quick recap",
        "what did we discuss in this thread",
        "produce a summary of this room",
        "TL;DR of the conversation please",
    ]
    for i in range(n):
        sc = SUMMARY_SCENARIOS[i % len(SUMMARY_SCENARIOS)]
        msg = phrasings[i % len(phrasings)]
        expected = {
            "text": sc["summary"],
            "topics": sc["topics"],
            "keyPoints": sc["keyPoints"],
        }
        yield build_record(
            encoder=encoder, task_id="initial_summarization", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_multi_step_summary(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "summarize the multi-step plan execution",
        "what were the steps and outcomes",
        "give me the workflow recap",
        "report on the multi-step task progress",
        "step-by-step summary please",
    ]
    for i in range(n):
        sc = SUMMARY_SCENARIOS[i % len(SUMMARY_SCENARIOS)]
        msg = phrasings[i % len(phrasings)]
        expected = {
            "summary": sc["summary"],
            "steps": [{"step": k + 1, "description": p} for k, p in enumerate(sc["keyPoints"])],
            "complete": True,
        }
        yield build_record(
            encoder=encoder, task_id="multi_step_summary", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_update_summarization(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "update the conversation summary with the latest turn",
        "fold the new messages into the running summary",
        "refresh the summary",
        "extend the summary",
        "merge in new context",
    ]
    for i in range(n):
        sc = SUMMARY_SCENARIOS[i % len(SUMMARY_SCENARIOS)]
        msg = phrasings[i % len(phrasings)]
        expected = {
            "text": sc["summary"] + " (Updated with the most recent turn.)",
            "topics": sc["topics"],
            "keyPoints": sc["keyPoints"],
        }
        yield build_record(
            encoder=encoder, task_id="update_summarization", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_post_action_decision(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "the action just completed — what's next",
        "decide the next move after the last action",
        "post-action: what should I do",
        "after that result, next step?",
        "now that the tool ran, what's the follow-up",
    ]
    decisions = ["continue", "stop", "ask_user", "retry"]
    for i in range(n):
        msg = phrasings[i % len(phrasings)]
        decision = decisions[i % len(decisions)]
        expected = {
            "decision": decision,
            "reason": {
                "continue": "the action succeeded — continuing the plan",
                "stop": "the goal is met, stopping",
                "ask_user": "ambiguous result, need user clarification",
                "retry": "transient failure, retrying once",
            }[decision],
        }
        yield build_record(
            encoder=encoder, task_id="post_action_decision", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_multi_step_decision(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "decide the next step in the plan",
        "which step comes next in the workflow",
        "advance the multi-step task",
        "what should we do next in this plan",
        "next move in the execution",
    ]
    steps = [("call_tool", "fetch_data"), ("call_tool", "validate"),
             ("ask_user", "confirm intent"), ("complete", ""),
             ("call_tool", "post_results")]
    for i in range(n):
        msg = phrasings[i % len(phrasings)]
        action, target = steps[i % len(steps)]
        expected = {
            "next_action": action,
            "target": target,
            "thought": f"Plan progress requires: {action} {target}".strip(),
        }
        yield build_record(
            encoder=encoder, task_id="multi_step_decision", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_post_creation(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    phrasings = [
        "draft a post about {topic}",
        "compose a tweet on {topic}",
        "write a quick post on {topic}",
        "social copy: {topic}",
        "draft channel announcement: {topic}",
    ]
    topics = ["the new release", "our hiring update", "an upcoming event",
              "a postmortem", "a community shoutout", "a roadmap teaser"]
    for i in range(n):
        topic = topics[i % len(topics)]
        msg = phrasings[i % len(phrasings)].format(topic=topic)
        expected = {
            "thought": f"Crafting a short post on {topic}.",
            "post": f"Heads up — wanted to share a quick note on {topic}. More details soon.",
        }
        yield build_record(
            encoder=encoder, task_id="post_creation", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_image_description(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    image_scenarios = [
        ("Sunset Over a Mountain Lake",
         "A serene lake reflecting orange and pink hues at sunset, framed by silhouetted mountains.",
         "The image captures a calm alpine lake at golden hour with vibrant orange and pink reflections on the water surface, jagged mountain silhouettes against the sky, and a small wooden dock in the foreground."),
        ("Modern Office Interior",
         "A bright, minimalist office space with white desks and large windows.",
         "An open-plan office featuring rows of white standing desks, ergonomic chairs, and floor-to-ceiling windows admitting natural light; a single monitor sits on each desk and a green wall plant softens the corner."),
        ("Street Food Vendor at Night",
         "A vendor cooking skewers under warm lights on a busy night street.",
         "A nighttime street market scene: vendor in white apron grilling skewered meats over a charcoal brazier, warm pendant lights overhead, customers blurred by motion in the background, neon shop signs in the distance."),
        ("Astronaut on the Moon",
         "An astronaut in a white spacesuit standing on the lunar surface beside a flag.",
         "A high-contrast composition showing a lone astronaut on the gray, cratered lunar surface, an Earth-flag planted nearby, deep black sky with no visible stars, lander module partially in frame on the right."),
        ("Vintage Bookshop",
         "Warm interior of an old bookshop with stacked shelves and a reading chair.",
         "Cozy vintage bookshop with floor-to-ceiling wooden shelves crammed with leather-bound books, a tasseled lampshade casting amber light, a worn green velvet chair in the corner, and a small ginger cat asleep on a stack of magazines."),
    ]
    for i in range(n):
        title, desc, full = image_scenarios[i % len(image_scenarios)]
        msg = "describe this image"
        expected = {
            "title": title,
            "description": desc,
            "text": full,
        }
        yield build_record(
            encoder=encoder, task_id="image_description", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_image_generation(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    prompts = [
        ("photo of a glass terrarium on a sunlit windowsill",
         "minimalist photo, glass terrarium with moss and pebbles, sunlit windowsill, soft morning light, shallow depth of field, 35mm"),
        ("painting of a ramen shop on a rainy Tokyo street",
         "oil painting, neon-lit ramen shop, wet asphalt, blurred passersby, warm interior glow, moody, brushy strokes"),
        ("cyberpunk skyline at dusk",
         "cinematic, cyberpunk skyline, dense neon signage, low-flying drones, magenta-cyan palette, volumetric haze, 35mm anamorphic"),
        ("a corgi in a tiny astronaut suit",
         "studio photo, welsh corgi wearing a hand-tailored astronaut suit, helmet visor reflecting earth, plain white seamless backdrop, soft key light"),
        ("watercolor of a mountain village in winter",
         "loose watercolor, alpine village in snow, smoke from chimneys, evergreen trees, granular pigment, paper texture visible"),
    ]
    for i in range(n):
        ask, prompt = prompts[i % len(prompts)]
        msg = f"generate an image: {ask}"
        expected = {
            "thought": f"User wants a {ask}; building a detailed prompt.",
            "prompt": prompt,
        }
        yield build_record(
            encoder=encoder, task_id="image_generation", user_msg=msg,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_reply(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    asks = [
        ("what's the weather in Tokyo today",
         "Mostly sunny in Tokyo today, around 22°C (72°F) with a light breeze."),
        ("translate 'good morning' into Japanese, Korean, and Spanish",
         "Japanese: おはようございます · Korean: 좋은 아침입니다 · Spanish: buenos días"),
        ("what does native JSON stand for",
         "native JSON stands for Token-Optimized Object Notation — a YAML-flavored compact format for LLM I/O."),
        ("summarize the last three messages briefly",
         "Three short turns about the design crit: tab bar approved, color contrast issues flagged, re-review next Tuesday."),
        ("tell me a short joke about computers",
         "I told my computer I needed a break. It said it was already on standby."),
    ]
    for i in range(n):
        ask, ans = asks[i % len(asks)]
        expected = {
            "thought": "Direct factual response, no tool use needed.",
            "text": ans,
        }
        yield build_record(
            encoder=encoder, task_id="reply", user_msg=ask,
            expected=expected, available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_message_classifier(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    msgs = [
        ("turn off the lights at 10pm", "simple", "direct_action",
         "scheduling,iot", "user", "single device", "device-online", 0.95),
        ("plan the launch event with the marketing team", "complex", "strategic_planning",
         "project_management,communication", "marketing,exec",
         "budget,timeline", "venue-booked", 0.85),
        ("what's 2 + 2", "simple", "direct_action",
         "math", "user", "none", "none", 0.99),
        ("organize a 4-week sprint roadmap", "medium", "sequential_planning",
         "project_management,analysis", "engineers,pm",
         "deadlines", "backlog-prioritized", 0.88),
        ("transform our entire customer support workflow", "enterprise", "strategic_planning",
         "process_design,change_management,analysis",
         "support,ops,exec", "budget,training,timeline", "tooling-decision", 0.75),
    ]
    for i in range(n):
        text, complexity, planning, caps, stakes, cons, deps, conf = msgs[i % len(msgs)]
        msg = f"classify this request: {text}"
        # Output format is text — multi-line key:value
        expected_text = "\n".join([
            f"COMPLEXITY: {complexity}",
            f"PLANNING: {planning}",
            f"CAPABILITIES: {caps}",
            f"STAKEHOLDERS: {stakes}",
            f"CONSTRAINTS: {cons}",
            f"DEPENDENCIES: {deps}",
            f"CONFIDENCE: {conf}",
        ])
        yield build_record(
            encoder=encoder, task_id="message_classifier", user_msg=msg,
            expected=expected_text,
            available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_extract_secrets(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    msgs = [
        ("Set my OpenAI key to sk-test-abcdef1234567890", "OPENAI_API_KEY", "sk-test-abcdef1234567890",
         "api_key", "OpenAI API access key"),
        ("My Anthropic API key is sk-ant-1234567890abcdef", "ANTHROPIC_API_KEY",
         "sk-ant-1234567890abcdef", "api_key", "Anthropic API access key"),
        ("Use this Discord token: MTAxMjM0NTY3.AbCdE.fghij", "DISCORD_BOT_TOKEN",
         "MTAxMjM0NTY3.AbCdE.fghij", "credential", "Discord bot token"),
        ("Set DATABASE_URL to postgres://user:pass@host:5432/db", "DATABASE_URL",
         "postgres://user:pass@host:5432/db", "url", "Postgres connection string"),
        ("Telegram token is 1234567890:AAAaaaBBBbbbCCC", "TELEGRAM_BOT_TOKEN",
         "1234567890:AAAaaaBBBbbbCCC", "credential", "Telegram bot token"),
    ]
    for i in range(n):
        ask, key, val, kind, desc = msgs[i % len(msgs)]
        expected_text = "\n".join([
            f"key: {key}",
            f"value: {val}",
            f"description: {desc}",
            f"type: {kind}",
        ])
        yield build_record(
            encoder=encoder, task_id="extract_secrets", user_msg=ask,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_extract_secret_operation(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    msgs = [
        ("What is my OpenAI key?", "get", "OPENAI_API_KEY", "", "user"),
        ("Do I have a Discord token set?", "check", "DISCORD_BOT_TOKEN", "", "user"),
        ("Show me all my secrets", "list", "", "", "user"),
        ("Delete my old API key", "delete", "", "", "user"),
        ("Remove TWITTER_API_KEY", "delete", "TWITTER_API_KEY", "", "user"),
        ("Set my key to sk-1234", "set", "OPENAI_API_KEY", "sk-1234", "user"),
    ]
    for i in range(n):
        ask, op, key, val, level = msgs[i % len(msgs)]
        expected_text = "\n".join([
            f"operation: {op}",
            f"key: {key}",
            f"value: {val}",
            f"level: {level}",
        ])
        yield build_record(
            encoder=encoder, task_id="extract_secret_operation", user_msg=ask,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_extract_secret_request(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    msgs = [
        ("I need an API key for OpenAI", "OPENAI_API_KEY", "Required to access the model"),
        ("Missing TWITTER_TOKEN", "TWITTER_TOKEN", "Required for tweet posting"),
        ("I cannot proceed without a Discord token", "DISCORD_TOKEN", "Required for Discord integration"),
        ("ANTHROPIC_API_KEY is unset", "ANTHROPIC_API_KEY", "Required to call Claude"),
        ("DATABASE_URL not configured", "DATABASE_URL", "Required for storage"),
    ]
    for i in range(n):
        ask, key, reason = msgs[i % len(msgs)]
        expected_text = json.dumps({"key": key, "reason": reason}, separators=(",", ":"))
        yield build_record(
            encoder=encoder, task_id="extract_secret_request", user_msg=ask,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_long_term_extraction(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    samples = [
        ("semantic", "User is a senior TypeScript developer with 8 years of backend experience.", 0.95),
        ("procedural", "User follows TDD workflow: writes tests before implementation, runs tests after each change.", 0.88),
        ("episodic", "User led database migration from MongoDB to PostgreSQL for payment system in Q2 2024.", 0.92),
        ("semantic", "User specializes in distributed systems and works at Acme Corp as technical lead.", 0.9),
        ("procedural", "User prefers git rebase over merge to keep history linear, applied across all repos.", 0.85),
    ]
    for i in range(n):
        cat, content, conf = samples[i % len(samples)]
        msg = "extract long-term memories from this conversation"
        expected_text = "\n".join([
            "memories[0]:",
            f"  category: {cat}",
            f"  content: {content}",
            f"  confidence: {conf}",
        ])
        yield build_record(
            encoder=encoder, task_id="long_term_extraction", user_msg=msg,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_message_handler(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    asks = [
        ("can you book a meeting with Jane next week",
         "I'll schedule a 30-minute slot with Jane for Tuesday at 10 AM ET. Confirm?"),
        ("what's the latest on the Acme renewal",
         "Acme is renewing at 1.5x current contract; SSO and audit logs are open requirements. Decision in two weeks."),
        ("send the design review notes to the team",
         "Done — sharing the design review notes to #design with the open accessibility issues highlighted."),
        ("turn on do-not-disturb for the rest of the day",
         "DND on until 7 PM. I'll silence non-urgent pings and surface anything from your VIP list."),
        ("summarize today's standup",
         "Three updates: backend unblocked the migration, frontend shipped the redesign behind a flag, ops paused alerts cleanup."),
    ]
    for i in range(n):
        ask, ans = asks[i % len(asks)]
        expected_text = ans
        yield build_record(
            encoder=encoder, task_id="message_handler", user_msg=ask,
            expected=expected_text,
            available_actions=[ACTION_REPLY, ACTION_TASK_CALL],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_autonomy(encoder: ExpectedResponseEncoder, rng: random.Random, n: int, task_id: str) -> Iterable[dict]:
    """Autonomy prompts emit <thought> + optional action — text format."""
    prompts = [
        "continue the autonomous loop",
        "decide what to do next",
        "advance the task",
        "make a small step of progress",
        "pick the next concrete action",
    ]
    thoughts = [
        "Reviewing the current state. The next useful step is to fetch the latest contact list before scheduling.",
        "I have enough context to act. Calling the calendar tool now.",
        "Nothing actionable this round — waiting for the user's next input.",
        "The previous action succeeded. Logging completion and pausing.",
        "Need more information before acting; will ask the user once they're back.",
    ]
    for i in range(n):
        msg = prompts[i % len(prompts)]
        expected_text = f"<thought>{thoughts[i % len(thoughts)]}</thought>"
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=msg,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_update_settings(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    settings = [
        ("notification_quiet_hours", "22:00-07:00", "Set quiet hours from 10 PM to 7 AM."),
        ("default_timezone", "America/New_York", "Updated default timezone to America/New_York."),
        ("language", "en", "Set primary language to English."),
        ("model_size", "large", "Using the large model for higher-quality outputs."),
        ("autonomy_mode", "supervised", "Autonomy is supervised — agent will ask before destructive actions."),
    ]
    for i in range(n):
        key, val, why = settings[i % len(settings)]
        msg = f"update setting: {key} = {val}"
        expected = {
            "key": key,
            "value": val,
            "thought": why,
        }
        yield build_record(
            encoder=encoder, task_id="update_settings", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


def gen_update_entity(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("ent-jane-001", "title", "VP of Design", "Jane was promoted from Senior Designer to VP of Design."),
        ("ent-mateo", "team", "platform", "Mateo joined the platform team."),
        ("ent-carla", "tier", "platinum", "Carla upgraded to platinum tier."),
        ("ent-lukas", "board_role", "observer", "Lukas joined as a board observer."),
        ("ent-ren", "status", "intern-active", "Ren started the summer internship."),
    ]
    for i in range(n):
        eid, field, val, why = cases[i % len(cases)]
        msg = f"update entity {eid}: {field} = {val}"
        expected = {
            "entity_id": eid,
            "field": field,
            "value": val,
            "thought": why,
        }
        yield build_record(
            encoder=encoder, task_id="update_entity", user_msg=msg,
            expected=expected, available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-core", rng=rng,
        )


# ─── plugin templates ──────────────────────────────────────────────────

DISCORD_CHANNELS = ["#general", "#announcements", "#engineering", "#design",
                    "#trading", "#ops", "#random", "#help-desk"]
DISCORD_USERS = ["alice#1234", "bob#0001", "carlos#4242", "diana#0007",
                 "ethan#2718", "fatima#3141"]


def gen_discord_attachment_ids(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    objectives = [
        "summarize these screenshots from the design crit",
        "extract the bullet points from the slides",
        "transcribe the voice memos shared earlier",
        "list every screenshot from the postmortem thread",
        "pull out the key details from the attached docs",
    ]
    ids_pool = [
        ["att-aaa-001", "att-aaa-002"],
        ["att-bbb-100", "att-bbb-101", "att-bbb-102"],
        ["att-ccc-7"],
        ["att-ddd-22", "att-ddd-23"],
        ["att-eee-9", "att-eee-10", "att-eee-11", "att-eee-12"],
    ]
    for i in range(n):
        obj = objectives[i % len(objectives)]
        ids = ids_pool[i % len(ids_pool)]
        msg = obj
        expected_text = json.dumps({"objective": obj, "attachmentIds": ids}, indent=2)
        yield build_record(
            encoder=encoder, task_id="plugin-discord.attachment_ids", user_msg=msg,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_attachment_summarization(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    summaries = [
        "Three screenshots from the design crit: tab-bar redesign, color audit, navigation flow.",
        "Slides cover Q2 priorities, hiring slowdown, and infra cost optimization.",
        "Voice memo: short status update from Mei on the migration, ETA Friday.",
        "Postmortem doc: stale TLS cert, alerting 40 min late, on-call rebalance planned.",
        "Spec doc: SSO + audit log requirements for the Acme renewal.",
    ]
    for i in range(n):
        msg = "summarize these attachments"
        yield build_record(
            encoder=encoder, task_id="plugin-discord.attachment_summarization", user_msg=msg,
            expected=summaries[i % len(summaries)],
            available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_channel_info(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"channelIdentifier": "#engineering", "focusUser": "alice#1234",
         "messageCount": 50, "summarize": True,
         "ask": "give me the last 50 messages from #engineering, focusing on alice#1234, summarized"},
        {"channelIdentifier": "#design", "focusUser": "", "messageCount": 100, "summarize": True,
         "ask": "summarize the last 100 messages from #design"},
        {"channelIdentifier": "#trading", "focusUser": "carlos#4242",
         "messageCount": 30, "summarize": False,
         "ask": "show me carlos#4242's last 30 messages in #trading"},
        {"channelIdentifier": "#ops", "focusUser": "", "messageCount": 75, "summarize": True,
         "ask": "what happened in #ops over the last 75 messages?"},
        {"channelIdentifier": "#general", "focusUser": "bob#0001", "messageCount": 25, "summarize": False,
         "ask": "list bob#0001's recent #general messages"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        out = {k: c[k] for k in ("channelIdentifier", "focusUser", "messageCount", "summarize")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.channel_info", user_msg=c["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_create_poll(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    polls = [
        {"question": "Where should we host the offsite?",
         "options": ["Lisbon", "Mexico City", "Bali"], "useEmojis": True,
         "ask": "make a poll: where should we host the offsite — Lisbon, Mexico City, or Bali"},
        {"question": "Ship Friday or hold?",
         "options": ["Ship Friday", "Hold to Monday"], "useEmojis": False,
         "ask": "poll the team: ship Friday or hold to Monday"},
        {"question": "Pick the new mascot color",
         "options": ["red", "blue", "green", "purple"], "useEmojis": True,
         "ask": "create a poll for the new mascot color: red, blue, green, purple"},
        {"question": "Friday lunch?",
         "options": ["pizza", "sushi", "tacos"], "useEmojis": True,
         "ask": "vote on Friday lunch — pizza, sushi, tacos"},
        {"question": "Move standup time?",
         "options": ["keep 9 AM", "move to 10 AM", "async only"], "useEmojis": False,
         "ask": "poll: keep standup at 9 AM, move to 10 AM, or go async-only?"},
    ]
    for i in range(n):
        p = polls[i % len(polls)]
        out = {k: p[k] for k in ("question", "options", "useEmojis")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.create_poll", user_msg=p["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_date_range(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"start": "2026-04-01", "end": "2026-04-30", "objective": "monthly digest of #engineering",
         "ask": "give me the April digest for #engineering"},
        {"start": "2026-05-01", "end": "2026-05-07", "objective": "weekly recap of #design",
         "ask": "summarize the first week of May in #design"},
        {"start": "2026-04-15", "end": "2026-04-22", "objective": "incident week recap in #ops",
         "ask": "what happened in #ops between April 15 and April 22?"},
        {"start": "2026-03-01", "end": "2026-03-31", "objective": "Q1 summary across all channels",
         "ask": "summarize March across the server"},
        {"start": "2026-05-01", "end": "2026-05-02", "objective": "yesterday and today in #trading",
         "ask": "what's been going on in #trading the past two days?"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        out = {k: c[k] for k in ("start", "end", "objective")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.date_range", user_msg=c["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_get_user_info(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"userIdentifier": "alice#1234", "detailed": True,
         "ask": "give me detailed info on alice#1234"},
        {"userIdentifier": "bob#0001", "detailed": False,
         "ask": "who is bob#0001?"},
        {"userIdentifier": "carlos#4242", "detailed": True,
         "ask": "full profile for carlos#4242"},
        {"userIdentifier": "diana#0007", "detailed": False,
         "ask": "quick lookup on diana#0007"},
        {"userIdentifier": "ethan#2718", "detailed": True,
         "ask": "deep dive on ethan#2718"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        out = {k: c[k] for k in ("userIdentifier", "detailed")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.get_user_info", user_msg=c["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_join_or_leave(encoder: ExpectedResponseEncoder, rng: random.Random, n: int,
                              task_id: str) -> Iterable[dict]:
    is_voice_pool = [True, False, False, True, False]
    verb = "join" if "join" in task_id else "leave"
    for i in range(n):
        ch = DISCORD_CHANNELS[i % len(DISCORD_CHANNELS)]
        is_voice = is_voice_pool[i % len(is_voice_pool)]
        if is_voice:
            ch_name = ch.lstrip("#") + "-voice"
            phrasing = f"{verb} the {ch_name} voice channel"
        else:
            ch_name = ch
            phrasing = f"{verb} {ch_name}"
        out = {"channelIdentifier": ch_name, "isVoiceChannel": is_voice}
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=phrasing,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_media_attachment_id(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    ids = ["att-img-001", "att-vid-014", "att-aud-007", "att-img-099", "att-pdf-22"]
    for i in range(n):
        aid = ids[i % len(ids)]
        msg = f"use attachment {aid}"
        out = {"attachmentId": aid}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.media_attachment_id", user_msg=msg,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_media_url(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    urls = [
        "https://cdn.discordapp.com/attachments/123/456/screen.png",
        "https://media.discordapp.net/attachments/789/012/clip.mp4",
        "https://cdn.discordapp.com/attachments/345/678/notes.pdf",
        "https://cdn.discordapp.com/attachments/901/234/audio.m4a",
        "https://cdn.discordapp.com/attachments/567/890/spec.md",
    ]
    for i in range(n):
        u = urls[i % len(urls)]
        msg = f"use this media: {u}"
        out = {"mediaUrl": u}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.media_url", user_msg=msg,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_pin_or_unpin(encoder: ExpectedResponseEncoder, rng: random.Random, n: int,
                             task_id: str) -> Iterable[dict]:
    refs = ["msg-aaa-1", "msg-bbb-22", "msg-ccc-300", "msg-ddd-9", "msg-eee-77"]
    verb = "pin" if "unpin" not in task_id else "unpin"
    phrasings = [
        f"{verb} message {{ref}}",
        f"{verb} this one: {{ref}}",
        f"please {verb} {{ref}} in the channel",
    ]
    for i in range(n):
        ref = refs[i % len(refs)]
        msg = phrasings[i % len(phrasings)].format(ref=ref)
        out = {"messageRef": ref}
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=msg,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_react_to_message(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"messageRef": "msg-aaa-1", "emoji": "🚀", "ask": "react to msg-aaa-1 with 🚀"},
        {"messageRef": "msg-bbb-22", "emoji": "✅", "ask": "✅ on msg-bbb-22 please"},
        {"messageRef": "msg-ccc-300", "emoji": "👀", "ask": "drop a 👀 on msg-ccc-300"},
        {"messageRef": "msg-ddd-9", "emoji": "❤️", "ask": "heart msg-ddd-9"},
        {"messageRef": "msg-eee-77", "emoji": "🔥", "ask": "fire emoji on msg-eee-77"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        out = {k: c[k] for k in ("messageRef", "emoji")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.react_to_message", user_msg=c["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_search_messages(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"query": "TLS cert", "channelIdentifier": "#ops", "author": "",
         "limit": 50, "timeRange": "last-7-days",
         "ask": "find every mention of TLS cert in #ops over the last week"},
        {"query": "renewal", "channelIdentifier": "#deals", "author": "alice#1234",
         "limit": 25, "timeRange": "last-30-days",
         "ask": "search alice#1234's messages in #deals about renewal in the last month"},
        {"query": "redesign", "channelIdentifier": "#design", "author": "",
         "limit": 100, "timeRange": "last-14-days",
         "ask": "look up everything in #design about redesign in the past two weeks"},
        {"query": "outage", "channelIdentifier": "", "author": "carlos#4242",
         "limit": 30, "timeRange": "all",
         "ask": "any messages from carlos#4242 about outage anywhere"},
        {"query": "WWDC", "channelIdentifier": "#engineering", "author": "",
         "limit": 20, "timeRange": "last-90-days",
         "ask": "search #engineering for WWDC mentions in the last 90 days"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        out = {k: c[k] for k in ("query", "channelIdentifier", "author", "limit", "timeRange")}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.search_messages", user_msg=c["ask"],
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_send_dm(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("alice#1234", "Quick Q — can you confirm the design crit time tomorrow?",
         "DM alice#1234 to confirm tomorrow's design crit"),
        ("bob#0001", "Sending the renewal docs over now, ping if anything's missing.",
         "send bob#0001 a DM about the renewal docs"),
        ("carlos#4242", "Following up on the trading recap — any blockers?",
         "DM carlos#4242 to follow up on the trading recap"),
        ("diana#0007", "Saw your update — looks great. Let's chat Monday.",
         "send diana#0007 a quick DM saying the update looks great and we'll chat Monday"),
        ("ethan#2718", "Don't forget the 1:1 at 3pm.",
         "remind ethan#2718 about the 3pm 1:1 in a DM"),
    ]
    for i in range(n):
        rec, content, ask = cases[i % len(cases)]
        out = {"recipientIdentifier": rec, "messageContent": content}
        yield build_record(
            encoder=encoder, task_id="plugin-discord.send_dm", user_msg=ask,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_summarization(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    summaries = [
        "Engineering team unblocked the migration, frontend shipped redesign behind a flag, ops paused alert cleanup.",
        "Design crit approved the new tab bar; three accessibility regressions to fix; re-review next Tuesday.",
        "Postmortem covered the auth outage — stale TLS cert, late alerting, on-call rebalance.",
        "Trading channel discussed Q2 strategy and risk limits; consensus to tighten exposure on tail names.",
        "Ops finalized the on-call rotation, drafted runbooks for the top three incident classes.",
    ]
    for i in range(n):
        msg = "summarize this Discord conversation"
        yield build_record(
            encoder=encoder, task_id="plugin-discord.summarization", user_msg=msg,
            expected=summaries[i % len(summaries)],
            available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_discord_transcription(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    transcripts = [
        "Hey team, quick update on the migration — Postgres cutover went smoothly, latency is down 18%.",
        "Reminder: design crit is moving to Tuesday at 2 PM. Bring the latest mocks.",
        "Heads up, the staging cluster will be down for maintenance from 10 PM to midnight.",
        "If you're on call this weekend, the new runbook for auth incidents is in #ops.",
        "Standup is async only this week — drop your update in the thread by 10 AM.",
    ]
    for i in range(n):
        msg = "transcribe this voice memo"
        yield build_record(
            encoder=encoder, task_id="plugin-discord.transcription", user_msg=msg,
            expected=transcripts[i % len(transcripts)],
            available_actions=[ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


# Plugin EVM
EVM_CHAINS = ["ethereum", "base", "polygon", "arbitrum", "optimism"]
EVM_TOKENS = ["USDC", "ETH", "DAI", "WBTC", "USDT", "WETH"]
EVM_ADDRS = [
    "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503",
    "0xa0b86a33E6441cd9F8C2eC0e7DcE3a48dba0c5b8",
    "0xb1ac39Bf3D74C8d23E91a8E26D5c67dCF4f7c843",
    "0xc8d3f7E7c7d4a8eA5F2a9D3a6e4d3F12dE5C7B8A",
]


def gen_evm_swap(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    swaps = [
        ("ethereum", "USDC", "ETH", "1000"),
        ("base", "ETH", "USDC", "0.5"),
        ("polygon", "USDC", "DAI", "200"),
        ("arbitrum", "WBTC", "ETH", "0.05"),
        ("optimism", "USDT", "USDC", "500"),
    ]
    phrasings = [
        "swap {amt} {fromT} for {toT} on {chain}",
        "convert {amt} {fromT} into {toT} on {chain}",
        "trade {amt} {fromT} → {toT} ({chain})",
        "execute a swap: {amt} {fromT} to {toT} on {chain}",
        "{chain}: swap {amt} {fromT} for {toT}",
    ]
    for i in range(n):
        chain, fromT, toT, amt = swaps[i % len(swaps)]
        msg = phrasings[i % len(phrasings)].format(amt=amt, fromT=fromT, toT=toT, chain=chain)
        expected = {
            "IMPORTANT": "Confirm before executing this on-chain swap.",
            "amount": amt,
            "chain": chain,
            "inputToken": fromT,
            "outputToken": toT,
        }
        yield build_record(
            encoder=encoder, task_id="plugin-evm.swap", user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_evm_transfer(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("ethereum", "USDC", "100", EVM_ADDRS[0]),
        ("base", "ETH", "0.1", EVM_ADDRS[1]),
        ("polygon", "DAI", "250", EVM_ADDRS[2]),
        ("arbitrum", "USDT", "50", EVM_ADDRS[3]),
        ("optimism", "WETH", "0.2", EVM_ADDRS[4]),
    ]
    for i in range(n):
        chain, token, amt, addr = cases[i % len(cases)]
        msg = f"transfer {amt} {token} to {addr} on {chain}"
        expected = {
            "IMPORTANT": "Confirm before executing this on-chain transfer.",
            "fromChain": chain,
            "amount": amt,
            "token": token,
            "toAddress": addr,
            "data": "",
        }
        yield build_record(
            encoder=encoder, task_id="plugin-evm.transfer", user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_evm_bridge(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("ethereum", "base", "USDC", "500", EVM_ADDRS[0]),
        ("polygon", "ethereum", "DAI", "1000", EVM_ADDRS[1]),
        ("arbitrum", "optimism", "USDT", "200", EVM_ADDRS[2]),
        ("base", "polygon", "USDC", "350", EVM_ADDRS[3]),
        ("optimism", "arbitrum", "ETH", "0.5", EVM_ADDRS[4]),
    ]
    for i in range(n):
        fromC, toC, token, amt, addr = cases[i % len(cases)]
        msg = f"bridge {amt} {token} from {fromC} to {toC} (recipient {addr})"
        expected = {
            "IMPORTANT": "Confirm before executing this cross-chain bridge.",
            "amount": amt,
            "fromChain": fromC,
            "toChain": toC,
            "token": token,
            "toAddress": addr,
        }
        yield build_record(
            encoder=encoder, task_id="plugin-evm.bridge", user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_evm_token_balance(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("ethereum", "USDC"),
        ("base", "ETH"),
        ("polygon", "DAI"),
        ("arbitrum", "WBTC"),
        ("optimism", "USDT"),
    ]
    for i in range(n):
        chain, token = cases[i % len(cases)]
        msg = f"what's my {token} balance on {chain}?"
        expected = {
            "IMPORTANT": "Read-only balance query.",
            "chain": chain,
            "token": token,
            "error": "",
        }
        yield build_record(
            encoder=encoder, task_id="plugin-evm.token_balance", user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_evm_governance(encoder: ExpectedResponseEncoder, rng: random.Random, n: int, task_id: str) -> Iterable[dict]:
    governors = [
        "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
        "0x408ED6354d4973f66138C91495F2f2FCbd8724C3",
        "0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab",
    ]
    cases = [
        ("ethereum", governors[0], "Increase quorum to 3% of supply",
         [EVM_ADDRS[0]], ["0"], ["0xa9059cbb0000"]),
        ("polygon", governors[1], "Adjust treasury allocation for Q2",
         [EVM_ADDRS[1], EVM_ADDRS[2]], ["0", "0"], ["0xabcd1234", "0xefef5678"]),
        ("arbitrum", governors[2], "Whitelist new collateral asset",
         [EVM_ADDRS[3]], ["0"], ["0xdeadbeef"]),
        ("base", governors[0], "Update fee receiver address",
         [EVM_ADDRS[4]], ["0"], ["0x12345678"]),
        ("optimism", governors[1], "Approve grant program funding round",
         [EVM_ADDRS[0], EVM_ADDRS[1]], ["100000000000000000", "200000000000000000"],
         ["0x10000001", "0x10000002"]),
    ]
    for i in range(n):
        chain, gov, desc, targets, values, calldatas = cases[i % len(cases)]
        msg = f"{task_id.split('.')[1].replace('_', ' ')} on {chain}: {desc}"
        expected = {
            "calldatas": calldatas,
            "chain": chain,
            "description": desc,
            "governor": gov,
            "targets": targets,
            "values": values,
        }
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=msg,
            expected=json.dumps(expected, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_evm_vote(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("ethereum", "0xc0Da02939E1441F497fd74F78cE7Decb17B66529", "42", 1),
        ("polygon", "0x408ED6354d4973f66138C91495F2f2FCbd8724C3", "17", 0),
        ("arbitrum", "0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab", "8", 2),
        ("base", "0xc0Da02939E1441F497fd74F78cE7Decb17B66529", "33", 1),
        ("optimism", "0x408ED6354d4973f66138C91495F2f2FCbd8724C3", "5", 0),
    ]
    support_word = {1: "for", 0: "against", 2: "abstain"}
    for i in range(n):
        chain, gov, pid, sup = cases[i % len(cases)]
        msg = f"vote {support_word[sup]} proposal {pid} on {chain}"
        expected = {"chain": chain, "governor": gov, "proposalId": pid, "support": sup}
        yield build_record(
            encoder=encoder, task_id="plugin-evm.vote", user_msg=msg,
            expected=json.dumps(expected, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_solana_swap(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"inputTokenSymbol": "SOL", "outputTokenSymbol": "USDC",
         "inputTokenCA": "So11111111111111111111111111111111111111112",
         "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
         "amount": "5"},
        {"inputTokenSymbol": "USDC", "outputTokenSymbol": "BONK",
         "inputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
         "outputTokenCA": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
         "amount": "100"},
        {"inputTokenSymbol": "JUP", "outputTokenSymbol": "SOL",
         "inputTokenCA": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
         "outputTokenCA": "So11111111111111111111111111111111111111112",
         "amount": "200"},
        {"inputTokenSymbol": "SOL", "outputTokenSymbol": "JTO",
         "inputTokenCA": "So11111111111111111111111111111111111111112",
         "outputTokenCA": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
         "amount": "1.5"},
        {"inputTokenSymbol": "WIF", "outputTokenSymbol": "USDC",
         "inputTokenCA": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
         "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
         "amount": "50"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        msg = f"swap {c['amount']} {c['inputTokenSymbol']} for {c['outputTokenSymbol']} on Solana"
        out = {k: c[k] for k in ("inputTokenSymbol", "outputTokenSymbol",
                                  "inputTokenCA", "outputTokenCA", "amount")}
        yield build_record(
            encoder=encoder, task_id="plugin-solana.swap", user_msg=msg,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_solana_transfer(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        {"recipient": "5xot8gC5dZGTNFJiE7CLqSGyqWzWZ9R6CuJ6BqGsHCcB",
         "tokenAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
         "amount": "100", "sym": "USDC"},
        {"recipient": "9XaePq2yK1NWWgUHGFbn3vP72Hh4Tk8U3w8AFY8Bz1xP",
         "tokenAddress": "So11111111111111111111111111111111111111112",
         "amount": "1.5", "sym": "SOL"},
        {"recipient": "3FdYG2eK7zL9D8wMqyKEehFdPvcnxJ4ZGz1wKuZ4PRdQ",
         "tokenAddress": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
         "amount": "10000", "sym": "BONK"},
        {"recipient": "7Lq9Pr9YnZx4mGHjZsKwAY8c2VnUq8j1Bp8WkGQK2x6t",
         "tokenAddress": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
         "amount": "25", "sym": "JTO"},
        {"recipient": "Ej5Tf2sMcZk3xJqyKD5L9N4Y8Ha6xJqPzCnUe3PvYj1A",
         "tokenAddress": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
         "amount": "75", "sym": "JUP"},
    ]
    for i in range(n):
        c = cases[i % len(cases)]
        msg = f"send {c['amount']} {c['sym']} to {c['recipient']}"
        out = {k: c[k] for k in ("recipient", "tokenAddress", "amount")}
        yield build_record(
            encoder=encoder, task_id="plugin-solana.transfer", user_msg=msg,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


def gen_shell_command_extraction(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    cases = [
        ("show me the disk usage on this machine", "df -h"),
        ("list all running docker containers", "docker ps"),
        ("count lines of code in the src directory", "find src -name '*.ts' | xargs wc -l"),
        ("tail the application log", "tail -f /var/log/app.log"),
        ("compress the build directory", "tar czf build.tar.gz build/"),
        ("show me the last 50 git commits", "git log -50 --oneline"),
        ("kill the process listening on port 3000", "lsof -ti:3000 | xargs kill -9"),
        ("rebuild the typescript project", "bun run build"),
        ("update all node packages", "bun update"),
        ("show network interfaces", "ip addr show"),
    ]
    for i in range(n):
        ask, cmd = cases[i % len(cases)]
        out = {"command": cmd}
        yield build_record(
            encoder=encoder, task_id="plugin-shell.command_extraction", user_msg=ask,
            expected=json.dumps(out, indent=2),
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "SHELL_COMMAND"],
            source_dataset="synth-action-pairs-plugins", rng=rng,
        )


# ─── lifeops generator ─────────────────────────────────────────────────

# Common lifeops phrasing variants so we can produce diverse user messages
# from the embedded "User message" line in each lifeops template.
LIFEOPS_PARAPHRASE_PREFIXES = [
    "",
    "hey, ",
    "real quick: ",
    "could you please — ",
    "todo: ",
    "fyi: ",
    "umm, ",
    "ok so ",
    "yo, ",
    "thinking: ",
]
LIFEOPS_PARAPHRASE_SUFFIXES = [
    "",
    " thanks!",
    " — when you can",
    " (no rush)",
    "?",
    " please",
    " 🙏",
    " whenever",
    "...",
    " — let me know",
]


_LIFEOPS_USER_RE = re.compile(r"User message:\s*(.+?)(?:\n\nExpected|$)", re.DOTALL)
_LIFEOPS_ACTION_RE = re.compile(r"Expected (?:primary )?action:\s*(\w+)")
_LIFEOPS_ACCEPTABLE_RE = re.compile(r'"acceptableActions":\s*\[([^\]]*)\]')
_LIFEOPS_FORBIDDEN_RE = re.compile(r'"forbiddenActions":\s*\[([^\]]*)\]')


def gen_lifeops(encoder: ExpectedResponseEncoder, rng: random.Random,
                lifeops_entries: list[dict], per_template: int) -> Iterable[dict]:
    for entry in lifeops_entries:
        tmpl = entry["template"]
        m_user = _LIFEOPS_USER_RE.search(tmpl)
        m_action = _LIFEOPS_ACTION_RE.search(tmpl)
        if not m_user:
            continue
        base_msg = m_user.group(1).strip()
        # Determine expected action label and acceptable / forbidden
        expected_action = None
        if m_action:
            ea = m_action.group(1).strip()
            if ea.upper() != "REPLY":
                expected_action = ea
        # Use the first example to read acceptableActions / forbiddenActions
        example = (entry.get("examples") or [None])[0]
        acceptable: list[str] = []
        forbidden: list[str] = []
        if example:
            try:
                ex = json.loads(example)
                if isinstance(ex, dict):
                    if ex.get("expectedAction") and not expected_action:
                        expected_action = ex["expectedAction"]
                    acceptable = ex.get("acceptableActions") or []
                    forbidden = ex.get("forbiddenActions") or []
            except Exception:  # noqa: BLE001
                pass

        for i in range(per_template):
            prefix = LIFEOPS_PARAPHRASE_PREFIXES[i % len(LIFEOPS_PARAPHRASE_PREFIXES)]
            suffix = LIFEOPS_PARAPHRASE_SUFFIXES[(i // len(LIFEOPS_PARAPHRASE_PREFIXES))
                                                 % len(LIFEOPS_PARAPHRASE_SUFFIXES)]
            paraphrased = f"{prefix}{base_msg}{suffix}".strip()

            # Phase-2 planner envelope. The action-pair signal (acceptable /
            # forbidden) rides under metadata so a downstream DPO/preference
            # pipeline can recover it without polluting the SFT supervised
            # target.
            primary = expected_action or ACTION_REPLY
            expected = {
                "thought": f"User wants {entry['task_id'].split('.', 2)[1].replace('-', ' ')}; pick action {primary}.",
                "actions": [{"name": primary, "params": {}}],
                "providers": [],
                "text": "",
                "simple": False,
            }
            available = [ACTION_TASK_CALL, ACTION_REPLY]
            if expected_action:
                available.append(expected_action)
            # task_type=agent_trace when there's a non-REPLY action to take;
            # task_type=reply when the canonical action is REPLY only.
            tt = "reply" if primary == ACTION_REPLY else "agent_trace"

            yield build_record(
                encoder=encoder, task_id=tt,
                user_msg=paraphrased,
                expected=expected,
                available_actions=available,
                source_dataset="synth-action-pairs-lifeops",
                rng=rng,
                extra_md={
                    "lifeops_scenario": entry["task_id"].split(".", 2)[1],
                    "lifeops_variant": entry["task_id"].rsplit(".", 1)[-1],
                    "lifeops_task_id": entry["task_id"],
                    # Preference-signal metadata — survives the SFT pack but
                    # is invisible to the supervised target.
                    "expected_action": expected_action,
                    "acceptable_actions": acceptable,
                    "forbidden_actions": forbidden,
                },
            )


# ─── action catalog generator ──────────────────────────────────────────

def _action_phrasings(action_name: str, plugin: str, params: list[dict]) -> list[str]:
    """Generate domain-appropriate phrasings for invoking the action."""
    # Friendly verb form of the action
    verb = action_name.lower().replace("_", " ")
    return [
        f"please {verb}",
        f"can you {verb}",
        f"go ahead and {verb}",
        f"{verb} now",
        f"trigger {action_name}",
        f"run the {verb} flow",
        f"kick off {verb}",
        f"do the {verb}",
    ]


def _sample_value_for_param(p: dict, plugin: str, action_name: str, idx: int,
                            rng: random.Random) -> Any:
    """Best-effort plausible value for a structured param."""
    name = p["name"]
    ptype = p.get("type", "string")
    # First, route by parameter name across ALL actions
    if ptype == "boolean":
        # `confirmed` defaults true in 'live' calls; alternate to inject diversity
        if name == "confirmed":
            return idx % 4 != 0  # 75% true
        return idx % 2 == 0
    if ptype == "number":
        if "limit" in name.lower():
            return [25, 50, 100, 200][idx % 4]
        if "amount" in name.lower():
            return [10, 50, 100, 1000][idx % 4]
        if "timeout" in name.lower():
            return [5000, 10000, 30000][idx % 3]
        if "issue" in name.lower():
            return [12, 47, 88, 102][idx % 4]
        if name in ("x", "y"):
            return [120, 480, 720, 1024][idx % 4]
        return [1, 5, 10, 25][idx % 4]
    if ptype == "array":
        if "modifiers" in name:
            return [["cmd"], ["ctrl", "shift"], ["alt"], ["cmd", "shift"]][idx % 4]
        if "coordinate" in name.lower() or name in ("startCoordinate",):
            return [[120, 240], [480, 360], [720, 540], [1024, 800]][idx % 4]
        if "statuses" in name.lower():
            return [["active"], ["completed"], ["paused", "active"], ["archived"]][idx % 4]
        return [["item-a", "item-b"], ["x"], ["alpha", "beta", "gamma"]][idx % 3]
    if ptype == "object":
        if "environment_vars" in name.lower():
            return [{"NODE_ENV": "production"},
                    {"LOG_LEVEL": "debug", "PORT": "3000"},
                    {"ANTHROPIC_API_KEY": "<redacted>"}][idx % 3]
        return {"key": "value"}

    # ptype == "string": branch by name semantics
    n = name.lower()
    pn = plugin
    an = action_name

    if "url" in n:
        if "git" in n or pn == "plugin-agent-orchestrator":
            return ["https://github.com/example/repo.git",
                    "https://github.com/elizaOS/eliza.git",
                    "https://github.com/anthropics/claude.git"][idx % 3]
        return ["https://example.com", "https://docs.elizaos.org",
                "https://github.com/issues/42", "https://acme.example/api"][idx % 4]
    if n == "repo":
        return ["elizaOS/eliza", "anthropics/claude-cookbooks",
                "eliza/training", "shaw/playground"][idx % 4]
    if n in ("commitmessage",):
        return ["fix: handle null user", "feat: add export endpoint",
                "chore: bump deps", "docs: update README"][idx % 4]
    if n == "prtitle":
        return ["Add feature X", "Fix bug Y", "Refactor Z module",
                "Cleanup unused imports"][idx % 4]
    if n == "prbody":
        return ["## Summary\n- Implements feature X with tests.",
                "## Summary\n- Fixes regression introduced in #42.\n## Test\n- bun run test"][idx % 2]
    if n == "basebranch":
        return ["main", "develop", "release/2026.05"][idx % 3]
    if "branch" in n:
        return ["feature/auth-flow", "fix/null-user", "chore/bumps"][idx % 3]

    # GitHub issues
    if n == "operation" and pn == "plugin-agent-orchestrator" and an == "MANAGE_ISSUES":
        return ["create", "list", "get", "comment", "close"][idx % 5]
    if n == "title":
        return ["Auth flow regression", "Add export endpoint",
                "Migration plan for Q2", "RFC: typed events"][idx % 4]
    if n == "body":
        return ["Reproduces on staging when user lacks email.",
                "We should expose CSV exports for admin users.",
                "Proposal to migrate cold storage to R2 in Q2."][idx % 3]
    if n == "labels":
        return ["bug,urgent", "enhancement", "rfc,discussion", "good-first-issue"][idx % 4]
    if n == "state":
        return ["open", "closed", "all"][idx % 3]

    # Agent orchestrator generic
    if n == "agenttype":
        return ["claude", "codex", "gemini", "shell"][idx % 4]
    if n == "approvalpreset":
        return ["read-only", "default", "auto-approve"][idx % 3]
    if n == "task":
        return ["investigate the failing test in apps/app",
                "draft a release note for v2.4",
                "audit the build pipeline for slow steps",
                "document the new auth middleware"][idx % 4]
    if n == "memorycontent":
        return ["You are working in a TypeScript monorepo. Use bun, not npm.",
                "Style: keep changes minimal; no broad refactors.",
                "When done, emit DONE on its own line."][idx % 3]
    if n == "workdir":
        return ["/home/user/repo", "/workspace/eliza", "/tmp/scratch"][idx % 3]
    if n == "sessionid" or n == "session_id":
        return ["sess-001", "sess-2026-05-01", "sess-abc123"][idx % 3]
    if n == "threadid":
        return ["thr-aa-1", "thr-bb-2", "thr-cc-3"][idx % 3]
    if n == "input":
        return ["yes, continue", "use option B",
                "skip this step and move to the next"][idx % 3]
    if n == "keys":
        return ["Enter", "Ctrl-C", "y"][idx % 3]
    if n == "search":
        return ["auth flow", "migration", "release notes"][idx % 3]
    if n == "note":
        return ["paused while waiting on review",
                "stopping due to flaky test",
                "resuming after dependency upgrade"][idx % 3]
    if n == "instruction":
        return ["focus on the failing tests first",
                "draft the PR with the changes so far",
                "investigate the staging logs"][idx % 3]
    if n == "metric":
        return ["list", "count", "detail"][idx % 3]
    if n == "window":
        return ["last-7-days", "last-30-days", "today"][idx % 3]
    if n == "label":
        return ["urgent", "follow-up", "exploration"][idx % 3]

    # APP / PLUGIN management
    if n == "mode":
        if an == "APP":
            return ["launch", "relaunch", "list", "create"][idx % 4]
        if an == "PLUGIN":
            return ["install", "list", "search", "sync"][idx % 4]
        return ["default", "fast", "full"][idx % 3]
    if n in ("app", "name") and an in ("APP", "PLUGIN"):
        if an == "APP":
            return ["companion", "homepage", "training-dashboard",
                    "weather-app"][idx % 4]
        return ["@elizaos/plugin-twitter", "@elizaos/plugin-discord",
                "plugin-evm", "@elizaos/plugin-shell"][idx % 4]
    if n == "intent":
        return ["a habit-tracker app for daily routines",
                "a plugin that exposes Linear issues to the agent",
                "a dashboard for monitoring on-call shifts",
                "a Spotify-like player wrapper"][idx % 4]
    if n == "edittarget":
        return ["companion", "homepage", "training-dashboard"][idx % 3]
    if n == "choice":
        return ["new", "edit-1", "cancel"][idx % 3]
    if n == "directory":
        return ["/home/user/projects/companion",
                "/workspace/training-dashboard"][idx % 2]
    if n == "version":
        return ["latest", "1.2.3", "alpha"][idx % 3]
    if n == "source":
        return ["npm", "git"][idx % 2]
    if n == "query":
        return ["calendar", "music", "github"][idx % 3]
    if n == "verify":
        return idx % 2 == 0

    # ComputerUse params
    if n == "action":
        if an == "BROWSER_ACTION":
            return ["open", "click", "type", "wait", "navigate"][idx % 5]
        if an == "FILE_ACTION":
            return ["read", "write", "append", "edit", "delete"][idx % 5]
        if an == "MANAGE_WINDOW":
            return ["focus", "switch", "arrange", "move"][idx % 4]
        if an == "TERMINAL_ACTION":
            return ["execute", "type", "connect"][idx % 3]
        if an == "USE_COMPUTER":
            return ["click", "type", "scroll", "drag"][idx % 4]
        return ["run"]
    if n in ("path", "filepath"):
        return ["/tmp/notes.md", "/etc/hosts", "src/index.ts",
                "/var/log/app.log"][idx % 4]
    if n in ("dirpath",):
        return ["/tmp", "/var/log", "src/", "build/"][idx % 4]
    if n == "content":
        return ["# Meeting Notes\n- Discuss roadmap\n- Pick reviewer",
                "console.log('hello world');",
                "appended line"][idx % 3]
    if n == "selector":
        return ["button.submit", "#search", "input[name=email]",
                ".tab-bar > a"][idx % 4]
    if n in ("oldtext", "old_text", "find"):
        return ["TODO", "console.log", "deprecated"][idx % 3]
    if n in ("newtext", "new_text", "replace"):
        return ["// done", "logger.info", "current"][idx % 3]
    if n == "encoding":
        return ["utf-8", "binary"][idx % 2]
    if n == "code":
        return ["document.title", "window.scrollTo(0, 0)",
                "document.querySelector('.next').click()"][idx % 3]
    if n == "direction" or n == "scrolldirection":
        return ["up", "down", "left", "right"][idx % 4]
    if n == "tabid":
        return ["tab-1", "tab-main", "tab-2"][idx % 3]
    if n == "windowid":
        return ["win-1", "win-main", "win-secondary"][idx % 3]
    if n == "windowtitle":
        return ["VS Code", "Chrome - Gmail", "Terminal"][idx % 3]
    if n == "arrangement":
        return ["tile", "cascade", "vertical", "horizontal"][idx % 4]
    if n == "command":
        return ["bun run test", "git status", "ls -la", "df -h"][idx % 4]
    if n == "cwd":
        return ["/home/user", "/workspace", "/tmp"][idx % 3]
    if n == "text":
        return ["hello", "type this into the field",
                "sample input"][idx % 3]
    if n == "key":
        return ["Enter", "cmd+s", "ctrl+shift+t"][idx % 3]
    if n == "button":
        return ["left", "right", "middle"][idx % 3]

    # ElizaCloud
    if n == "containerid":
        return ["c-aaa-001", "c-bbb-002", "c-ccc-003"][idx % 3]
    if n == "project_name":
        return ["my-agent-prod", "support-bot", "research-agent"][idx % 3]
    if n == "snapshotid":
        return ["snap-2026-05-01", "snap-2026-04-15", "snap-latest"][idx % 3]
    if n == "description":
        return ["Production support agent",
                "Research assistant for the data team",
                "Customer-facing agent with limited tools"][idx % 3]
    if n == "detailed":
        return idx % 2 == 0

    # Twitter
    if n == "recipient":
        return ["alice_in_chains", "bob_dev", "carlos_eng"][idx % 3]
    if n == "maxresults":
        return [10, 50, 100][idx % 3]

    # Generic fallback
    return f"sample-{name}-{idx}"


def gen_action_with_params(encoder: ExpectedResponseEncoder, rng: random.Random,
                           action: dict, n_per: int) -> Iterable[dict]:
    plugin = action.get("plugin", "")
    action_name = action["name"]
    params = action.get("parameters") or []
    phrasings = _action_phrasings(action_name, plugin, params)
    intents = [
        f"{action_name.lower().replace('_', ' ')} for me",
        f"please run {action_name}",
        f"go ahead and {action_name.lower().replace('_', ' ')}",
        f"trigger {action_name}",
        f"can you {action_name.lower().replace('_', ' ')}",
    ]
    for i in range(n_per):
        # Build arguments: include all required + half of optionals
        args: dict[str, Any] = {}
        for j, p in enumerate(params):
            if p.get("required") or (i + j) % 2 == 0:
                args[p["name"]] = _sample_value_for_param(p, plugin, action_name, i, rng)
        msg = intents[i % len(intents)] + " — " + phrasings[i % len(phrasings)]
        # If there's a `confirmed` boolean, surface that intent in the message
        if "confirmed" in args and args["confirmed"]:
            msg += " (confirmed)"

        # native JSON tool_calls envelope
        expected = {
            "tool_calls": [{
                "name": action_name,
                "arguments": args,
            }],
        }
        yield build_record(
            encoder=encoder,
            task_id="tool_call",
            user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action_name],
            source_dataset="synth-action-pairs-actions",
            rng=rng,
            extra_md={
                "action_name": action_name,
                "plugin": plugin,
            },
        )


def gen_action_no_params(encoder: ExpectedResponseEncoder, rng: random.Random,
                        action: dict, n_per: int) -> Iterable[dict]:
    plugin = action.get("plugin", "")
    action_name = action["name"]
    desc = (action.get("description") or "").strip()
    phrasings = [
        f"please {action_name.lower().replace('_', ' ')}",
        f"can you {action_name.lower().replace('_', ' ')}",
        f"trigger {action_name}",
        f"run {action_name}",
        f"go ahead, {action_name.lower().replace('_', ' ')}",
    ]
    if desc:
        phrasings.append(f"{desc.split('.')[0].strip().lower()} please")
        phrasings.append(f"do this: {desc.split('.')[0].strip().lower()}")
    for i in range(n_per):
        msg = phrasings[i % len(phrasings)]
        expected = {
            "tool_calls": [{
                "name": action_name,
                "arguments": {},
            }],
        }
        yield build_record(
            encoder=encoder,
            task_id="tool_call",
            user_msg=msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action_name],
            source_dataset="synth-action-pairs-actions",
            rng=rng,
            extra_md={
                "action_name": action_name,
                "plugin": plugin,
            },
        )


# ─── inline-action templates (delete/write/search/append/read .extract) ──

CLIPBOARD_ENTRIES = [
    {"id": "cb-001", "title": "design notes", "content": "tab bar redesign approved"},
    {"id": "cb-002", "title": "renewal blockers", "content": "SSO and audit logs"},
    {"id": "cb-003", "title": "team todo", "content": "rebalance on-call"},
    {"id": "cb-004", "title": "trip ideas", "content": "Lisbon, Mexico City, Bali"},
    {"id": "cb-005", "title": "interview loop", "content": "Mateo: backend infra"},
]


def gen_clipboard_extract(encoder: ExpectedResponseEncoder, rng: random.Random, n: int,
                          task_id: str) -> Iterable[dict]:
    """Inline-action templates from plugin-clipboard (.extract)."""
    for i in range(n):
        e = CLIPBOARD_ENTRIES[i % len(CLIPBOARD_ENTRIES)]
        if task_id == "delete.extract":
            msg = f"delete clipboard entry {e['id']}"
            expected_text = f"<response>\n<id>{e['id']}</id>\n</response>"
        elif task_id == "write.extract":
            msg = f"save '{e['content']}' as {e['title']}"
            expected_text = (f"<response>\n<title>{e['title']}</title>\n"
                             f"<content>{e['content']}</content>\n"
                             f"<tags>note,saved</tags>\n</response>")
        elif task_id == "search.extract":
            ask_terms = ["renewal", "design", "trip", "interview", "todo"]
            t = ask_terms[i % len(ask_terms)]
            msg = f"search clipboard for {t}"
            expected_text = (f"<response>\n<query>{t}</query>\n"
                             f"<maxResults>5</maxResults>\n</response>")
        elif task_id == "append.extract":
            extra = ["additional context", "follow-up note", "second thought"][i % 3]
            msg = f"append to {e['id']}: {extra}"
            expected_text = (f"<response>\n<id>{e['id']}</id>\n"
                             f"<content>{extra}</content>\n</response>")
        elif task_id == "read.extract":
            msg = f"read clipboard entry {e['id']} from line 1, 10 lines"
            expected_text = (f"<response>\n<id>{e['id']}</id>\n"
                             f"<from>1</from>\n<lines>10</lines>\n</response>")
        else:
            continue
        yield build_record(
            encoder=encoder, task_id=task_id, user_msg=msg,
            expected=expected_text,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY],
            source_dataset="synth-action-pairs-inline-actions", rng=rng,
        )


def gen_dataset_generator_should_respond(encoder: ExpectedResponseEncoder, rng: random.Random,
                                         n: int) -> Iterable[dict]:
    """Inline action template for dataset-generator should_respond (payload)."""
    actions_cycle = [ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP]
    contexts = ["wallet", "scheduling", "incident-response", "support",
                "design-review", "general", "personal"]
    for i in range(n):
        action = actions_cycle[i % 3]
        agent = rng.choice(AGENT_NAMES)
        msg_pool = {
            ACTION_RESPOND: [f"@{agent} take a look", f"{agent} can you help"],
            ACTION_IGNORE: ["thanks team", "no need to reply"],
            ACTION_STOP: [f"stop {agent}", f"{agent} please be quiet"],
        }
        msg = msg_pool[action][i % 2]
        ctx = contexts[i % len(contexts)]
        expected = {
            "name": agent,
            "reasoning": {
                ACTION_RESPOND: f"{agent} was directly addressed.",
                ACTION_IGNORE: "no direct address to the agent.",
                ACTION_STOP: "user asked the agent to stop.",
            }[action],
            "action": action,
            "primaryContext": ctx,
            "secondaryContexts": "",
            "evidenceTurnIds": "",
        }
        rec = build(
            roomName=stable_id("synth-action-pairs", "should_respond",
                               msg, agent, action),
            agentId=agent.lower(),
            memoryEntries=[],
            currentMessage={"role": "user", "speaker": rng.choice(USER_NAMES),
                            "content": msg, "channel": "public"},
            expectedResponse=encoder.encode(expected),
            availableActions=[ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP],
            task_type="should_respond",
            source_dataset="synth-action-pairs-inline-actions",
            license="synthetic", split="train",
            extra_metadata={"agent_name": agent, "synth_target_action": action,
                            "synth_origin": "dataset-generator.should_respond"},
        )
        yield rec.to_dict()


# ─── orchestration ──────────────────────────────────────────────────────

CORE_PROMPT_GENERATORS: dict[str, Any] = {
    "add_contact": gen_add_contact,
    "remove_contact": gen_remove_contact,
    "search_contacts": gen_search_contacts,
    "schedule_follow_up": gen_schedule_follow_up,
    "update_contact": gen_update_contact,
    "update_role": gen_update_role,
    "should_mute_room": lambda enc, rng, n: gen_should_room(enc, rng, n, "should_mute_room"),
    "should_unmute_room": lambda enc, rng, n: gen_should_room(enc, rng, n, "should_unmute_room"),
    "should_follow_room": lambda enc, rng, n: gen_should_room(enc, rng, n, "should_follow_room"),
    "should_unfollow_room": lambda enc, rng, n: gen_should_room(enc, rng, n, "should_unfollow_room"),
    "should_respond": lambda enc, rng, n: gen_should_respond(enc, rng, n, with_context=False),
    "should_respond_with_context": lambda enc, rng, n: gen_should_respond(enc, rng, n, with_context=True),
    "choose_option": gen_choose_option,
    "option_extraction": gen_option_extraction,
    "reflection": gen_reflection,
    "reflection_evaluator": gen_reflection_evaluator,
    "think": gen_think,
    "initial_summarization": gen_initial_summarization,
    "multi_step_summary": gen_multi_step_summary,
    "update_summarization": gen_update_summarization,
    "post_action_decision": gen_post_action_decision,
    "multi_step_decision": gen_multi_step_decision,
    "post_creation": gen_post_creation,
    "image_description": gen_image_description,
    "image_generation": gen_image_generation,
    "reply": gen_reply,
    "message_classifier": gen_message_classifier,
    "extract_secrets": gen_extract_secrets,
    "extract_secret_operation": gen_extract_secret_operation,
    "extract_secret_request": gen_extract_secret_request,
    "long_term_extraction": gen_long_term_extraction,
    "message_handler": gen_message_handler,
    "update_settings": gen_update_settings,
    "update_entity": gen_update_entity,
    "autonomy_continuous_continue": lambda enc, rng, n: gen_autonomy(enc, rng, n, "autonomy_continuous_continue"),
    "autonomy_continuous_first": lambda enc, rng, n: gen_autonomy(enc, rng, n, "autonomy_continuous_first"),
    "autonomy_task_continue": lambda enc, rng, n: gen_autonomy(enc, rng, n, "autonomy_task_continue"),
    "autonomy_task_first": lambda enc, rng, n: gen_autonomy(enc, rng, n, "autonomy_task_first"),
}


PLUGIN_PROMPT_GENERATORS: dict[str, Any] = {
    "plugin-discord.attachment_ids": gen_discord_attachment_ids,
    "plugin-discord.attachment_summarization": gen_discord_attachment_summarization,
    "plugin-discord.channel_info": gen_discord_channel_info,
    "plugin-discord.create_poll": gen_discord_create_poll,
    "plugin-discord.date_range": gen_discord_date_range,
    "plugin-discord.get_user_info": gen_discord_get_user_info,
    "plugin-discord.join_channel":
        lambda enc, rng, n: gen_discord_join_or_leave(enc, rng, n, "plugin-discord.join_channel"),
    "plugin-discord.leave_channel":
        lambda enc, rng, n: gen_discord_join_or_leave(enc, rng, n, "plugin-discord.leave_channel"),
    "plugin-discord.media_attachment_id": gen_discord_media_attachment_id,
    "plugin-discord.media_url": gen_discord_media_url,
    "plugin-discord.pin_message":
        lambda enc, rng, n: gen_discord_pin_or_unpin(enc, rng, n, "plugin-discord.pin_message"),
    "plugin-discord.unpin_message":
        lambda enc, rng, n: gen_discord_pin_or_unpin(enc, rng, n, "plugin-discord.unpin_message"),
    "plugin-discord.react_to_message": gen_discord_react_to_message,
    "plugin-discord.search_messages": gen_discord_search_messages,
    "plugin-discord.send_dm": gen_discord_send_dm,
    "plugin-discord.summarization": gen_discord_summarization,
    "plugin-discord.transcription": gen_discord_transcription,
    "plugin-evm.swap": gen_evm_swap,
    "plugin-evm.transfer": gen_evm_transfer,
    "plugin-evm.bridge": gen_evm_bridge,
    "plugin-evm.token_balance": gen_evm_token_balance,
    "plugin-evm.execute_proposal":
        lambda enc, rng, n: gen_evm_governance(enc, rng, n, "plugin-evm.execute_proposal"),
    "plugin-evm.propose":
        lambda enc, rng, n: gen_evm_governance(enc, rng, n, "plugin-evm.propose"),
    "plugin-evm.queue_proposal":
        lambda enc, rng, n: gen_evm_governance(enc, rng, n, "plugin-evm.queue_proposal"),
    "plugin-evm.vote": gen_evm_vote,
    "plugin-solana.swap": gen_solana_swap,
    "plugin-solana.transfer": gen_solana_transfer,
    "plugin-shell.command_extraction": gen_shell_command_extraction,
}


INLINE_ACTION_GENERATORS: dict[str, Any] = {
    "delete.extract":
        lambda enc, rng, n: gen_clipboard_extract(enc, rng, n, "delete.extract"),
    "write.extract":
        lambda enc, rng, n: gen_clipboard_extract(enc, rng, n, "write.extract"),
    "search.extract":
        lambda enc, rng, n: gen_clipboard_extract(enc, rng, n, "search.extract"),
    "append.extract":
        lambda enc, rng, n: gen_clipboard_extract(enc, rng, n, "append.extract"),
    "read.extract":
        lambda enc, rng, n: gen_clipboard_extract(enc, rng, n, "read.extract"),
    "dataset-generator.should_respond": gen_dataset_generator_should_respond,
}


def write_jsonl(records: Iterable[dict], path: Path) -> int:
    n = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core-per", type=int, default=100,
                    help="examples per core prompt template")
    ap.add_argument("--plugin-per", type=int, default=100,
                    help="examples per plugin prompt template")
    ap.add_argument("--lifeops-per", type=int, default=50,
                    help="examples per lifeops scenario variant")
    ap.add_argument("--action-with-params-per", type=int, default=100,
                    help="examples per action that has structured params")
    ap.add_argument("--action-no-params-per", type=int, default=30,
                    help="examples per action with no params")
    ap.add_argument("--seed", type=int, default=0xACE_2026)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    actions_data = json.loads(ACTIONS_PATH.read_text(encoding="utf-8"))

    core_entries = [e for e in registry["entries"] if e["source_kind"] == "core"]
    inline_action_entries = [e for e in registry["entries"] if e["source_kind"] == "action"]
    plugin_entries = [e for e in registry["entries"] if e["source_kind"] == "plugin"]
    lifeops_entries = [e for e in registry["entries"] if e["source_kind"] == "lifeops"]

    encoder = JsonExpectedResponseEncoder()
    counts: dict[str, int] = {}

    try:
        # A. core prompts (38)
        log.info("Synthesizing core prompts (%d × %d ≈ %d)",
                 len(core_entries), args.core_per, len(core_entries) * args.core_per)
        core_records: list[dict] = []
        skipped_core: list[str] = []
        for entry in core_entries:
            tid = entry["task_id"]
            gen = CORE_PROMPT_GENERATORS.get(tid)
            if not gen:
                skipped_core.append(tid)
                continue
            for r in gen(encoder, rng, args.core_per):
                core_records.append(r)
        n = write_jsonl(core_records, OUT_DIR / "core-prompts.jsonl")
        counts["core-prompts"] = n
        log.info("  wrote %d core records (skipped: %s)", n, skipped_core)

        # Inline action templates (6)
        log.info("Synthesizing inline-action prompts (%d × %d)",
                 len(inline_action_entries), args.core_per)
        inline_records: list[dict] = []
        skipped_inline: list[str] = []
        for entry in inline_action_entries:
            tid = entry["task_id"]
            gen = INLINE_ACTION_GENERATORS.get(tid)
            if not gen:
                skipped_inline.append(tid)
                continue
            for r in gen(encoder, rng, args.core_per):
                inline_records.append(r)
        n = write_jsonl(inline_records, OUT_DIR / "inline-actions.jsonl")
        counts["inline-actions"] = n
        log.info("  wrote %d inline-action records (skipped: %s)", n, skipped_inline)

        # B. plugin prompts (28)
        log.info("Synthesizing plugin prompts (%d × %d)", len(plugin_entries), args.plugin_per)
        plugin_records: list[dict] = []
        skipped_plugins: list[str] = []
        for entry in plugin_entries:
            tid = entry["task_id"]
            gen = PLUGIN_PROMPT_GENERATORS.get(tid)
            if not gen:
                skipped_plugins.append(tid)
                continue
            for r in gen(encoder, rng, args.plugin_per):
                plugin_records.append(r)
        n = write_jsonl(plugin_records, OUT_DIR / "plugin-prompts.jsonl")
        counts["plugin-prompts"] = n
        log.info("  wrote %d plugin records (skipped: %s)", n, skipped_plugins)

        # C. lifeops (410 × 50)
        log.info("Synthesizing lifeops (%d × %d ≈ %d)",
                 len(lifeops_entries), args.lifeops_per,
                 len(lifeops_entries) * args.lifeops_per)
        lifeops_records: list[dict] = list(
            gen_lifeops(encoder, rng, lifeops_entries, args.lifeops_per)
        )
        n = write_jsonl(lifeops_records, OUT_DIR / "lifeops.jsonl")
        counts["lifeops"] = n
        log.info("  wrote %d lifeops records", n)

        # D. action catalog
        actions = actions_data["actions"]
        with_params = [a for a in actions if a.get("parameters")]
        no_params = [a for a in actions if not a.get("parameters")]
        log.info("Synthesizing action catalog (%d with-params × %d, %d no-params × %d)",
                 len(with_params), args.action_with_params_per,
                 len(no_params), args.action_no_params_per)
        action_records: list[dict] = []
        for action in with_params:
            for r in gen_action_with_params(encoder, rng, action, args.action_with_params_per):
                action_records.append(r)
        for action in no_params:
            for r in gen_action_no_params(encoder, rng, action, args.action_no_params_per):
                action_records.append(r)
        n = write_jsonl(action_records, OUT_DIR / "actions-catalog.jsonl")
        counts["actions-catalog"] = n
        log.info("  wrote %d action records", n)
    finally:
        encoder.close()

    total = sum(counts.values())
    log.info("=== synthesis summary ===")
    for k, v in counts.items():
        log.info("  %s: %d", k, v)
    log.info("  TOTAL: %d", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
