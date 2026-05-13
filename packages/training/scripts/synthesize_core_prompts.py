"""Rule-based synthesis of ~100 records each for 8 under-represented core prompts.

Targets (one native JSON expectedResponse schema per task — see docstrings):

    reflection             reflect on conversation -> facts/relationships
    reflection_evaluator   rate a previous reflection
    extract_secrets        find API keys/tokens/etc in a user message
    choose_option          pick one of N offered options
    message_classifier     classify a single message (question/request/...)
    multi_step_decision    decompose a complex ask into ordered steps
    add_contact            extract a new contact from a message
    should_follow_room     decide whether to actively follow a room

Output: 8 jsonl files under data/synthesized/core_prompts/<task_id>.jsonl,
100 records each, total 800.

Each record:
    {
      "roomName":         "<random-12-hex>",
      "agentId":          "agent",
      "memoryEntries":    [<0-3 turns>],
      "currentMessage":   {"role":"user","speaker":"<persona>","content":"..."},
      "expectedResponse": "<native JSON document>",
      "availableActions": ["REPLY","IGNORE"],
      "metadata":         {"task_type": ..., "synth_origin": "core-prompts-gen",
                            "synth_lang": ..., "synth_style": ...}
    }

Run:
    .venv/bin/python scripts/synthesize_core_prompts.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import build, stable_id  # noqa: E402
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

OUT_DIR = ROOT / "data" / "synthesized" / "core_prompts"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-core-prompts")


# ─────────────────────────── shared diversity pools ─────────────────────────

PERSONAS = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas", "yuna", "marcus",
    "claire", "miguel", "deepa", "kenji", "luca", "naomi", "owen",
    "renata",
]

LANGS = ["en", "zh", "es", "fr", "ja", "de", "pt"]
STYLES = [
    "direct", "formal", "casual", "expert",
    "naive", "voice-asr", "broken-english", "distracted",
]


def en_styled(rng: random.Random, base: str, style: str) -> str:
    """Apply an English style transform to a base prompt."""
    if style == "direct":
        return base
    if style == "formal":
        return f"Could you please {base[0].lower() + base[1:]}? Thank you."
    if style == "casual":
        return rng.choice([f"hey, {base.lower()}", f"yo {base.lower()}", f"{base.lower()} pls"])
    if style == "expert":
        return f"{base} (precision matters)"
    if style == "naive":
        return rng.choice([f"um, {base.lower()}", f"i guess {base.lower()}", f"maybe {base.lower()}?"])
    if style == "voice-asr":
        # mid-sentence caps, missing punctuation
        return base.lower().replace(".", "").replace(",", "")
    if style == "broken-english":
        # crude: drop articles
        words = base.split()
        return " ".join(w for w in words if w.lower() not in {"the", "a", "an"})
    if style == "distracted":
        return f"{base} -- wait, hold on"
    return base


# ─────────────────────────── memory snippets pool ───────────────────────────

MEMORY_POOL_0: list[list[tuple[str, str]]] = [[]]

MEMORY_POOL_1_2: list[list[tuple[str, str]]] = [
    [("user", "hey are you around"), ("agent", "yep, what's up?")],
    [("user", "got a sec to help with something"), ("agent", "sure, fire away.")],
    [("agent", "all caught up — anything else?"), ("user", "actually yeah")],
    [("user", "morning"), ("agent", "morning! how's it going?")],
    [("user", "thanks for the help earlier"), ("agent", "anytime.")],
    [("agent", "got it logged."), ("user", "cool")],
    [("user", "you online?"), ("agent", "always.")],
    [("user", "back from lunch"), ("agent", "wb. picking back up?")],
]

MEMORY_POOL_3: list[list[tuple[str, str]]] = [
    [
        ("user", "I had a long meeting with Sara today"),
        ("agent", "How did it go?"),
        ("user", "Productive — she runs ops at Acme."),
    ],
    [
        ("user", "thinking about hiring my friend Marcus"),
        ("agent", "What's his background?"),
        ("user", "Backend dev, we worked together at Stripe."),
    ],
    [
        ("agent", "Quick update: deploy is green."),
        ("user", "nice"),
        ("agent", "What's next on the list?"),
    ],
    [
        ("user", "starting a new fitness routine"),
        ("agent", "Fun. What kind?"),
        ("user", "Mostly running and yoga twice a week."),
    ],
    [
        ("user", "my landlord raised rent again"),
        ("agent", "Ugh, by how much?"),
        ("user", "Another $200/mo. Considering moving."),
    ],
    [
        ("agent", "Reminder: dentist tomorrow at 10."),
        ("user", "thanks"),
        ("agent", "Want me to book an Uber too?"),
    ],
]


def pick_memory(rng: random.Random) -> list[tuple[str, str]]:
    """30% empty / 50% 1-2 turns / 20% 3 turns."""
    r = rng.random()
    if r < 0.30:
        return rng.choice(MEMORY_POOL_0)
    if r < 0.80:
        return rng.choice(MEMORY_POOL_1_2)
    return rng.choice(MEMORY_POOL_3)


def to_memory_entries(speaker: str, agent: str, snippet: list[tuple[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for role, text in snippet:
        out.append({
            "role": "user" if role == "user" else "assistant",
            "speaker": speaker if role == "user" else agent,
            "content": text,
            "channel": "dm",
        })
    return out


# ─────────────────────────── language plan helper ───────────────────────────

def language_plan(n: int, rng: random.Random) -> list[str]:
    """Return n language tags: ~70 en, ~30 split across 6 non-en (>=3 each)."""
    en = 70
    non_en_total = n - en
    non_en_langs = ["zh", "es", "fr", "ja", "de", "pt"]
    base = non_en_total // len(non_en_langs)
    rem = non_en_total - base * len(non_en_langs)
    plan: list[str] = ["en"] * en
    for i, lg in enumerate(non_en_langs):
        cnt = base + (1 if i < rem else 0)
        plan.extend([lg] * cnt)
    rng.shuffle(plan)
    return plan


def style_plan(n: int, rng: random.Random) -> list[str]:
    """Return n style tags evenly spread across STYLES."""
    out: list[str] = []
    for i in range(n):
        out.append(STYLES[i % len(STYLES)])
    rng.shuffle(out)
    return out


# ─────────────────────────── shared record builder ──────────────────────────

def build_record(
    *,
    encoder: ExpectedResponseEncoder,
    task_type: str,
    user_msg: str,
    expected_obj: dict[str, Any],
    rng: random.Random,
    memory_snippet: list[tuple[str, str]],
    language: str,
    style: str,
) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = "agent"
    memory = to_memory_entries(speaker, agent, memory_snippet)
    expected_str = encoder.encode(expected_obj)

    md = {
        "synth_origin": "core-prompts-gen",
        "synth_lang": language,
        "synth_style": style,
    }
    rec = build(
        roomName=stable_id("synth-core-prompts", task_type, user_msg, language, style)[:12],
        agentId=agent,
        memoryEntries=memory,
        currentMessage={
            "role": "user",
            "speaker": speaker,
            "content": user_msg,
            "channel": "dm",
        },
        expectedResponse=expected_str,
        availableActions=["REPLY", "IGNORE"],
        task_type=task_type,
        source_dataset="synth-core-prompts",
        license="synthetic",
        split="train",
        extra_metadata=md,
    )
    return rec.to_dict()


# ─────────────────────────── 1) reflection ──────────────────────────────────
# Memory contains turns; user_msg is the most recent assistant or user turn
# the agent reflects on. We expose user-style "reflection" inputs by including
# an explicit reflection-trigger message.

REFLECTION_SCENARIOS = [
    {
        "trigger": "I just got promoted to engineering manager at Stripe.",
        "facts": [
            ("User was promoted to engineering manager.", "fact"),
            ("User works at Stripe.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "My sister Lila is moving to Berlin next month.",
        "facts": [
            ("User has a sister named Lila.", "fact"),
            ("Lila is moving to Berlin next month.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Lila", "relation": "family"}],
    },
    {
        "trigger": "Hung out with my coworker David — he's also into climbing.",
        "facts": [
            ("User has a coworker named David.", "fact"),
            ("David is into climbing.", "fact"),
            ("User is into climbing.", "fact"),
        ],
        "rels": [{"source": "user", "target": "David", "relation": "colleague"}],
    },
    {
        "trigger": "I'm vegan and allergic to peanuts.",
        "facts": [
            ("User is vegan.", "fact"),
            ("User is allergic to peanuts.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "My partner Jaime and I just bought a house in Austin.",
        "facts": [
            ("User has a partner named Jaime.", "fact"),
            ("User and Jaime bought a house in Austin.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Jaime", "relation": "partner"}],
    },
    {
        "trigger": "Started running again — 5k three times a week.",
        "facts": [
            ("User runs 5k three times a week.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "My friend Aisha just had a baby boy named Idris.",
        "facts": [
            ("User has a friend named Aisha.", "fact"),
            ("Aisha had a baby boy named Idris.", "fact"),
        ],
        "rels": [
            {"source": "user", "target": "Aisha", "relation": "friend"},
            {"source": "Aisha", "target": "Idris", "relation": "family"},
        ],
    },
    {
        "trigger": "Met my new neighbor Tom — he runs a bakery on 5th street.",
        "facts": [
            ("User has a neighbor named Tom.", "fact"),
            ("Tom runs a bakery on 5th street.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Tom", "relation": "neighbor"}],
    },
    {
        "trigger": "I switched from Slack to Linear at work this week.",
        "facts": [
            ("User switched from Slack to Linear at work.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "My dog Mochi is a 3-year-old shiba inu.",
        "facts": [
            ("User has a dog named Mochi.", "fact"),
            ("Mochi is a 3-year-old shiba inu.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Mochi", "relation": "pet"}],
    },
    {
        "trigger": "Quit my job at Google last Friday to start a company.",
        "facts": [
            ("User quit their job at Google.", "fact"),
            ("User is starting a company.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "My mom Helen lives in Toronto and visits twice a year.",
        "facts": [
            ("User's mother is Helen.", "fact"),
            ("Helen lives in Toronto.", "fact"),
            ("Helen visits user twice a year.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Helen", "relation": "family"}],
    },
    {
        "trigger": "I speak Spanish fluently and basic Mandarin.",
        "facts": [
            ("User speaks Spanish fluently.", "fact"),
            ("User speaks basic Mandarin.", "fact"),
        ],
        "rels": [],
    },
    {
        "trigger": "Rohan and I are building a startup together — we co-founded it last year.",
        "facts": [
            ("User co-founded a startup with Rohan last year.", "fact"),
        ],
        "rels": [{"source": "user", "target": "Rohan", "relation": "cofounder"}],
    },
    {
        "trigger": "I usually drink decaf after 2pm because of insomnia.",
        "facts": [
            ("User drinks decaf after 2pm.", "fact"),
            ("User has insomnia.", "fact"),
        ],
        "rels": [],
    },
]

REFLECTION_LANG_TEMPLATES = {
    "zh": "{t}",
    "es": "{t}",
    "fr": "{t}",
    "ja": "{t}",
    "de": "{t}",
    "pt": "{t}",
}

REFLECTION_TRANSLATIONS = {
    "zh": {
        "I just got promoted to engineering manager at Stripe.": "我刚刚被提升为 Stripe 的工程经理。",
        "My sister Lila is moving to Berlin next month.": "我妹妹 Lila 下个月要搬去柏林。",
        "I'm vegan and allergic to peanuts.": "我是素食主义者,而且对花生过敏。",
        "Started running again — 5k three times a week.": "我又开始跑步了——每周三次,每次 5 公里。",
        "My dog Mochi is a 3-year-old shiba inu.": "我的狗 Mochi 是一只三岁的柴犬。",
    },
    "es": {
        "I just got promoted to engineering manager at Stripe.": "Acaban de promocionarme a gerente de ingeniería en Stripe.",
        "My sister Lila is moving to Berlin next month.": "Mi hermana Lila se muda a Berlín el mes que viene.",
        "I'm vegan and allergic to peanuts.": "Soy vegano y alérgico a los cacahuetes.",
        "Started running again — 5k three times a week.": "Volví a correr, 5km tres veces por semana.",
        "My dog Mochi is a 3-year-old shiba inu.": "Mi perro Mochi es un shiba inu de 3 años.",
    },
    "fr": {
        "I just got promoted to engineering manager at Stripe.": "Je viens d'être promu manager d'ingénierie chez Stripe.",
        "My sister Lila is moving to Berlin next month.": "Ma sœur Lila déménage à Berlin le mois prochain.",
        "I'm vegan and allergic to peanuts.": "Je suis végane et allergique aux cacahuètes.",
        "Started running again — 5k three times a week.": "J'ai recommencé à courir, 5km trois fois par semaine.",
        "My dog Mochi is a 3-year-old shiba inu.": "Mon chien Mochi est un shiba inu de 3 ans.",
    },
    "ja": {
        "I just got promoted to engineering manager at Stripe.": "Stripe でエンジニアリングマネージャーに昇進しました。",
        "My sister Lila is moving to Berlin next month.": "妹のライラが来月ベルリンに引っ越します。",
        "I'm vegan and allergic to peanuts.": "私はビーガンでピーナッツアレルギーです。",
        "Started running again — 5k three times a week.": "またランニングを始めました。週3回5km走っています。",
        "My dog Mochi is a 3-year-old shiba inu.": "うちの犬モチは3歳の柴犬です。",
    },
    "de": {
        "I just got promoted to engineering manager at Stripe.": "Ich wurde gerade bei Stripe zum Engineering Manager befördert.",
        "My sister Lila is moving to Berlin next month.": "Meine Schwester Lila zieht nächsten Monat nach Berlin.",
        "I'm vegan and allergic to peanuts.": "Ich bin Veganer und allergisch gegen Erdnüsse.",
        "Started running again — 5k three times a week.": "Ich laufe wieder, 5km dreimal die Woche.",
        "My dog Mochi is a 3-year-old shiba inu.": "Mein Hund Mochi ist ein 3 Jahre alter Shiba Inu.",
    },
    "pt": {
        "I just got promoted to engineering manager at Stripe.": "Acabei de ser promovido a gerente de engenharia na Stripe.",
        "My sister Lila is moving to Berlin next month.": "Minha irmã Lila vai se mudar para Berlim no próximo mês.",
        "I'm vegan and allergic to peanuts.": "Sou vegano e alérgico a amendoim.",
        "Started running again — 5k three times a week.": "Voltei a correr, 5km três vezes por semana.",
        "My dog Mochi is a 3-year-old shiba inu.": "Meu cachorro Mochi é um shiba inu de 3 anos.",
    },
}


def gen_reflection(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        sc = REFLECTION_SCENARIOS[i % len(REFLECTION_SCENARIOS)]
        language = langs[i]
        style = styles[i]
        trigger = sc["trigger"]
        if language != "en":
            trans = REFLECTION_TRANSLATIONS.get(language, {})
            trigger = trans.get(trigger, trigger)
        if language == "en":
            user_msg = en_styled(rng, trigger, style)
        else:
            user_msg = trigger
        thought = "Extracting durable facts and any explicit relationships from the user's recent statement."
        expected = {
            "thought": thought,
            "facts": [{"text": t, "type": k} for t, k in sc["facts"]],
            "relationships": list(sc["rels"]),
        }
        yield build_record(
            encoder=encoder,
            task_type="reflection",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 2) reflection_evaluator ────────────────────────

REFLECTION_EVALUATOR_CASES = [
    {
        "reflection": "User likes pizza.",
        "rating": 2,
        "critique": "Too generic; lacks specificity (which user, when, what kind of pizza, why this matters).",
        "suggestions": [
            "Identify the user by ID or stable handle.",
            "Add the source utterance for traceability.",
            "Tag durability so trivial preferences don't drown out durable facts.",
        ],
    },
    {
        "reflection": "User mentioned moving to Berlin and starting a new job at SAP next month.",
        "rating": 5,
        "critique": "Strong: two durable facts, a temporal anchor, and an employer entity.",
        "suggestions": [
            "Add a relationship edge user→SAP (employer).",
            "Tag the move as a future event with a target date.",
        ],
    },
    {
        "reflection": "Something happened maybe.",
        "rating": 1,
        "critique": "No content. Empty hedging — adds noise to the memory store.",
        "suggestions": [
            "Drop the reflection entirely.",
            "Require at least one verifiable fact before persisting.",
        ],
    },
    {
        "reflection": "User has a dog named Mochi (shiba inu, 3 years old).",
        "rating": 4,
        "critique": "Specific and durable, but missing relationship modeling.",
        "suggestions": [
            "Add a user→Mochi pet relationship.",
            "Capture breed and age as separate structured facts.",
        ],
    },
    {
        "reflection": "User is happy.",
        "rating": 1,
        "critique": "Affective state, not durable. Reflections should target stable facts.",
        "suggestions": [
            "Filter out transient mood reflections.",
            "If retained, mark as transient with a TTL.",
        ],
    },
    {
        "reflection": "User said her sister Aisha just had a baby boy named Idris.",
        "rating": 5,
        "critique": "Two clear entities and a family relationship; durable.",
        "suggestions": [
            "Add user→Aisha (family) and Aisha→Idris (family) edges.",
            "Note Idris's birth as an event for future context.",
        ],
    },
    {
        "reflection": "User probably might be a vegan? Not sure.",
        "rating": 2,
        "critique": "Hedged language indicates low confidence; persisting hedged claims pollutes memory.",
        "suggestions": [
            "Wait for a more definitive statement before recording.",
            "If kept, attach an explicit confidence score below threshold.",
        ],
    },
    {
        "reflection": "User works at Stripe and was just promoted to engineering manager.",
        "rating": 5,
        "critique": "Concrete, durable, employer-anchored; useful for future context.",
        "suggestions": [
            "Add user→Stripe (employer) edge.",
            "Note the role transition timestamp.",
        ],
    },
    {
        "reflection": "User mentioned the weather is nice today.",
        "rating": 1,
        "critique": "Ephemeral observation about weather. Not a durable fact.",
        "suggestions": [
            "Discard; weather is transient.",
            "Reserve reflections for stable user attributes or relationships.",
        ],
    },
    {
        "reflection": "User is allergic to peanuts and is vegan.",
        "rating": 5,
        "critique": "Two durable health/diet facts; high relevance for future suggestions.",
        "suggestions": [
            "Tag as health/diet category for retrieval prioritization.",
            "Cross-reference with any prior contradictory facts.",
        ],
    },
    {
        "reflection": "User said something about a meeting.",
        "rating": 1,
        "critique": "Vague — no extracted entity or topic; no value to memory.",
        "suggestions": [
            "Re-run extraction with stricter requirements.",
            "Drop until the model can name participants or topic.",
        ],
    },
    {
        "reflection": "User co-founded a startup with Rohan in 2024 in the AI space.",
        "rating": 5,
        "critique": "Durable, concrete; entities and relationship are explicit.",
        "suggestions": [
            "Add user→Rohan (cofounder) edge.",
            "Tag the company as an entity for future references.",
        ],
    },
    {
        "reflection": "User said hi.",
        "rating": 1,
        "critique": "Greeting-only utterance produced no facts; reflection adds nothing.",
        "suggestions": [
            "Skip reflections for greeting-only turns.",
            "Use a content-density check before invoking the reflector.",
        ],
    },
    {
        "reflection": "User has a partner named Jaime and they just bought a house in Austin.",
        "rating": 5,
        "critique": "Two durable facts plus a relationship; geographically anchored.",
        "suggestions": [
            "Add user→Jaime (partner) edge.",
            "Capture the city as a structured location attribute.",
        ],
    },
    {
        "reflection": "User does things sometimes.",
        "rating": 1,
        "critique": "Empty content; pure filler.",
        "suggestions": [
            "Drop.",
            "Treat as no-op output rather than a reflection event.",
        ],
    },
]

EVAL_TRANSLATIONS = {
    "zh": "请评估这段反思的质量。",
    "es": "Por favor evalúa la calidad de esta reflexión.",
    "fr": "Évaluez la qualité de cette réflexion.",
    "ja": "この反省の質を評価してください。",
    "de": "Bitte bewerte die Qualität dieser Reflexion.",
    "pt": "Avalie a qualidade desta reflexão.",
}


def gen_reflection_evaluator(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = REFLECTION_EVALUATOR_CASES[i % len(REFLECTION_EVALUATOR_CASES)]
        language = langs[i]
        style = styles[i]
        prefix = (
            "Evaluate this reflection: "
            if language == "en"
            else f"{EVAL_TRANSLATIONS[language]} "
        )
        base = f"{prefix}\"{case['reflection']}\""
        if language == "en":
            user_msg = en_styled(rng, base, style)
        else:
            user_msg = base
        expected = {
            "rating": case["rating"],
            "critique": case["critique"],
            "suggestions": list(case["suggestions"]),
        }
        yield build_record(
            encoder=encoder,
            task_type="reflection_evaluator",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 3) extract_secrets ─────────────────────────────

SECRET_CASES = [
    {
        "msg": "Here's the staging key: sk_live_abc123XYZdefXYZ4567890",
        "secrets": [
            {"kind": "api_key", "value": "sk_live_abc123XYZdefXYZ4567890",
             "redacted": "Here's the staging key: ***"},
        ],
    },
    {
        "msg": "Use my GitHub token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234 to clone.",
        "secrets": [
            {"kind": "token", "value": "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234",
             "redacted": "Use my GitHub token *** to clone."},
        ],
    },
    {
        "msg": "Database url: postgres://admin:hunter2@db.example.com:5432/prod",
        "secrets": [
            {"kind": "password", "value": "hunter2",
             "redacted": "Database url: postgres://admin:***@db.example.com:5432/prod"},
        ],
    },
    {
        "msg": "OpenAI key for the demo: sk-proj-XYZ987ABCDEF456GHIJKL789MNOPQRSTUVWXYZ",
        "secrets": [
            {"kind": "api_key", "value": "sk-proj-XYZ987ABCDEF456GHIJKL789MNOPQRSTUVWXYZ",
             "redacted": "OpenAI key for the demo: ***"},
        ],
    },
    {
        "msg": "Card 4242 4242 4242 4242 exp 12/27 cvv 123",
        "secrets": [
            {"kind": "credit_card", "value": "4242 4242 4242 4242",
             "redacted": "Card *** exp 12/27 cvv 123"},
        ],
    },
    {
        "msg": "I lost my SSH key, here's the new one:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----",
        "secrets": [
            {"kind": "ssh_key", "value": "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAK...\\n-----END RSA PRIVATE KEY-----",
             "redacted": "I lost my SSH key, here's the new one:\\n***"},
        ],
    },
    {
        "msg": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "secrets": [
            {"kind": "api_key", "value": "AKIAIOSFODNN7EXAMPLE",
             "redacted": "AWS_ACCESS_KEY_ID=*** AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
            {"kind": "api_key", "value": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
             "redacted": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET=***"},
        ],
    },
    {
        "msg": "What's the weather like tomorrow?",
        "secrets": [],
    },
    {
        "msg": "Can you summarize this article for me?",
        "secrets": [],
    },
    {
        "msg": "Slack webhook https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
        "secrets": [
            {"kind": "token", "value": "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
             "redacted": "Slack webhook ***"},
        ],
    },
    {
        "msg": "Login to my server with password CorrectHorseBatteryStaple",
        "secrets": [
            {"kind": "password", "value": "CorrectHorseBatteryStaple",
             "redacted": "Login to my server with password ***"},
        ],
    },
    {
        "msg": "JWT for testing: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "secrets": [
            {"kind": "token", "value": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
             "redacted": "JWT for testing: ***"},
        ],
    },
    {
        "msg": "Lunch was great today, thanks for asking.",
        "secrets": [],
    },
    {
        "msg": "Stripe test key sk_test_FAKE_NOT_A_REAL_KEY_xyz",
        "secrets": [
            {"kind": "api_key", "value": "sk_test_FAKE_NOT_A_REAL_KEY_xyz",
             "redacted": "Stripe test key ***"},
        ],
    },
    {
        "msg": "Here's the wifi password — sunshine42!",
        "secrets": [
            {"kind": "password", "value": "sunshine42!",
             "redacted": "Here's the wifi password — ***"},
        ],
    },
    {
        "msg": "Just thinking about lunch options.",
        "secrets": [],
    },
    {
        "msg": "Card on file: 5555 5555 5555 4444",
        "secrets": [
            {"kind": "credit_card", "value": "5555 5555 5555 4444",
             "redacted": "Card on file: ***"},
        ],
    },
]

SECRET_LANG_PREFIX = {
    "zh": "这是我的密钥:",
    "es": "Aquí está mi clave:",
    "fr": "Voici ma clé :",
    "ja": "私の鍵はこれです:",
    "de": "Hier ist mein Schlüssel:",
    "pt": "Aqui está minha chave:",
}

SECRET_LANG_NULL = {
    "zh": "今天天气怎么样?",
    "es": "¿Cómo está el clima hoy?",
    "fr": "Quel temps fait-il aujourd'hui ?",
    "ja": "今日の天気はどうですか?",
    "de": "Wie ist das Wetter heute?",
    "pt": "Como está o tempo hoje?",
}


def gen_extract_secrets(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = SECRET_CASES[i % len(SECRET_CASES)]
        language = langs[i]
        style = styles[i]
        msg = case["msg"]
        if language != "en":
            if not case["secrets"]:
                msg = SECRET_LANG_NULL[language]
            else:
                # keep the secret bits English (real-world: secrets are alphanumeric tokens)
                first_secret = case["secrets"][0]["value"]
                msg = f"{SECRET_LANG_PREFIX[language]} {first_secret}"
                redacted = f"{SECRET_LANG_PREFIX[language]} ***"
                expected = {
                    "secrets": [{
                        "kind": case["secrets"][0]["kind"],
                        "value": first_secret,
                        "redacted": redacted,
                    }],
                }
                yield build_record(
                    encoder=encoder,
                    task_type="extract_secrets",
                    user_msg=msg,
                    expected_obj=expected,
                    rng=rng,
                    memory_snippet=pick_memory(rng),
                    language=language,
                    style=style,
                )
                continue

        if language == "en":
            user_msg = en_styled(rng, msg, style) if style != "voice-asr" else msg
        else:
            user_msg = msg

        expected = {"secrets": [dict(s) for s in case["secrets"]]}
        yield build_record(
            encoder=encoder,
            task_type="extract_secrets",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 4) choose_option ───────────────────────────────

CHOOSE_OPTION_CASES = [
    {
        "options": ["Pizza", "Tacos", "Sushi", "Burgers"],
        "context": "for dinner tonight, considering my partner is vegetarian",
        "selected": "Pizza",
        "thought": "Pizza accommodates vegetarian preferences with cheese/veggie variants and is the most flexible group choice.",
    },
    {
        "options": ["7am", "9am", "11am", "2pm"],
        "context": "to schedule the standup; the team is distributed across PST and CET",
        "selected": "9am",
        "thought": "9am PST = 6pm CET, an acceptable evening for CET and morning for PST.",
    },
    {
        "options": ["TypeScript", "Python", "Rust", "Go"],
        "context": "for a backend service that needs strong typing and high concurrency",
        "selected": "Go",
        "thought": "Go's lightweight goroutines and static typing match the concurrency + type-safety requirements with the simplest deployment story.",
    },
    {
        "options": ["United", "Delta", "American", "Southwest"],
        "context": "for a coast-to-coast flight where I value reliability over price",
        "selected": "Delta",
        "thought": "Delta has the highest on-time performance among major US carriers per recent rankings.",
    },
    {
        "options": ["Coffee", "Tea", "Water", "Juice"],
        "context": "as a morning drink; I want caffeine but mild on the stomach",
        "selected": "Tea",
        "thought": "Tea provides caffeine but is gentler on the stomach than coffee.",
    },
    {
        "options": ["Cardio", "Strength", "Yoga", "Rest"],
        "context": "given I lifted heavy yesterday and feel sore",
        "selected": "Yoga",
        "thought": "Yoga supports active recovery without overloading sore muscles.",
    },
    {
        "options": ["Postgres", "MongoDB", "DynamoDB", "SQLite"],
        "context": "for a low-traffic embedded app with no cloud infra",
        "selected": "SQLite",
        "thought": "SQLite is file-local, zero-config, and ideal for low-traffic embedded use cases.",
    },
    {
        "options": ["Notion", "Obsidian", "Apple Notes", "Bear"],
        "context": "for personal note-taking with offline-first and markdown",
        "selected": "Obsidian",
        "thought": "Obsidian is offline-first, file-based, and uses plain markdown.",
    },
    {
        "options": ["Drive", "Train", "Fly", "Bus"],
        "context": "from NYC to Boston for a one-day meeting",
        "selected": "Train",
        "thought": "The Acela is faster than driving with city-center arrivals and avoids airport overhead.",
    },
    {
        "options": ["Hire FTE", "Contract", "Outsource", "Defer"],
        "context": "for a 2-month frontend project with uncertain follow-up demand",
        "selected": "Contract",
        "thought": "A contractor matches the fixed scope without long-term salary commitment.",
    },
    {
        "options": ["A: 8% APY 12mo lock", "B: 5% APY no lock", "C: 3% APY savings", "D: stocks"],
        "context": "for an emergency fund I might need access to within 3 months",
        "selected": "B: 5% APY no lock",
        "thought": "Emergency funds need liquidity; lockup or stock volatility disqualify the others.",
    },
    {
        "options": ["Buy new", "Buy used", "Rent", "Borrow"],
        "context": "for a power drill I'll use exactly once",
        "selected": "Borrow",
        "thought": "Single-use → borrowing avoids cost and storage entirely.",
    },
    {
        "options": ["Beach vacation", "City trip", "Hiking", "Cruise"],
        "context": "with a 5-year-old and a 2-year-old in summer",
        "selected": "Beach vacation",
        "thought": "Toddler-friendly, low-logistics, summer-appropriate; cruise/hiking are awkward at those ages.",
    },
    {
        "options": ["GPT-4", "Claude", "Gemini", "open-source"],
        "context": "for a privacy-sensitive on-prem deployment",
        "selected": "open-source",
        "thought": "On-prem privacy → open-source models you can self-host are the only option that meets the constraint.",
    },
    {
        "options": ["Slack", "Discord", "Teams", "Email"],
        "context": "for fast async chat in a 5-person open-source project",
        "selected": "Discord",
        "thought": "Discord is free, voice-capable, and standard in OSS communities of this size.",
    },
]


def gen_choose_option(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = CHOOSE_OPTION_CASES[i % len(CHOOSE_OPTION_CASES)]
        language = langs[i]
        style = styles[i]
        opts_str = " / ".join(case["options"])
        if language == "en":
            base = f"Pick one: {opts_str} — {case['context']}"
            user_msg = en_styled(rng, base, style)
        elif language == "zh":
            user_msg = f"请从中选一个:{opts_str}({case['context']})"
        elif language == "es":
            user_msg = f"Elige una: {opts_str} — {case['context']}"
        elif language == "fr":
            user_msg = f"Choisis-en une : {opts_str} — {case['context']}"
        elif language == "ja":
            user_msg = f"一つ選んでください: {opts_str}({case['context']})"
        elif language == "de":
            user_msg = f"Wähl eine aus: {opts_str} — {case['context']}"
        else:  # pt
            user_msg = f"Escolha uma: {opts_str} — {case['context']}"
        expected = {
            "thought": case["thought"],
            "selected_option": case["selected"],
            "selected_index": case["options"].index(case["selected"]),
        }
        yield build_record(
            encoder=encoder,
            task_type="choose_option",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 5) message_classifier ──────────────────────────

CLASSIFIER_CASES = [
    ("How do I reset my password?", "question", 0.95, "asks for a procedure"),
    ("Please book a meeting room for tomorrow at 10.", "request", 0.96, "imperative request with time"),
    ("This is the third time the app has crashed today, ridiculous.", "complaint", 0.92, "negative sentiment, repeated failure"),
    ("Hey, good morning!", "greeting", 0.99, "standard morning greeting"),
    ("Talk to you later, bye!", "farewell", 0.99, "explicit goodbye"),
    ("haha yeah totally, anyway, did you watch the game?", "smalltalk", 0.85, "casual filler with topic shift"),
    ("Can you generate a quarterly sales report by Friday?", "task", 0.94, "deliverable + deadline"),
    ("rofl", "smalltalk", 0.7, "single internet acronym, low signal but social"),
    ("when is my next dentist appointment?", "question", 0.95, "info-seeking with WH-word"),
    ("schedule a 1:1 with Maria for next Thursday at 3pm", "task", 0.96, "explicit scheduling task"),
    ("the wifi has been down for 4 hours, fix it", "complaint", 0.9, "frustration + demand"),
    ("hi there", "greeting", 0.98, "minimal greeting"),
    ("see ya", "farewell", 0.95, "casual goodbye"),
    ("did you see what happened in the news?", "smalltalk", 0.8, "open conversational opener"),
    ("send the invoice to billing@example.com", "request", 0.94, "imperative with destination"),
    ("what's the capital of France?", "question", 0.99, "factual question"),
    ("write a 500-word blog post about Rust", "task", 0.95, "concrete deliverable with constraint"),
    ("I'm not happy with how this was handled at all", "complaint", 0.93, "explicit dissatisfaction"),
    ("good night, sleep well", "farewell", 0.97, "evening goodbye"),
    ("yo", "greeting", 0.85, "very short informal greeting"),
    ("can you summarize this PDF", "request", 0.92, "imperative on attached doc"),
    ("the food was cold and the service slow", "complaint", 0.92, "explicit negatives"),
    ("how does photosynthesis work?", "question", 0.97, "scientific WH-question"),
    ("set up a Zoom for Tuesday at 11", "task", 0.95, "concrete logistical task"),
    ("anything new this week?", "smalltalk", 0.8, "open social check-in"),
]

CLASSIFIER_TRANSLATIONS = {
    ("How do I reset my password?", "zh"): "我怎么重置密码?",
    ("How do I reset my password?", "es"): "¿Cómo restablezco mi contraseña?",
    ("How do I reset my password?", "fr"): "Comment réinitialiser mon mot de passe ?",
    ("How do I reset my password?", "ja"): "パスワードのリセット方法は?",
    ("How do I reset my password?", "de"): "Wie setze ich mein Passwort zurück?",
    ("How do I reset my password?", "pt"): "Como redefino minha senha?",
    ("Hey, good morning!", "zh"): "嘿,早上好!",
    ("Hey, good morning!", "es"): "¡Hola, buenos días!",
    ("Hey, good morning!", "fr"): "Salut, bonjour !",
    ("Hey, good morning!", "ja"): "やあ、おはよう!",
    ("Hey, good morning!", "de"): "Hey, guten Morgen!",
    ("Hey, good morning!", "pt"): "Olá, bom dia!",
    ("Talk to you later, bye!", "zh"): "回头再聊,再见!",
    ("Talk to you later, bye!", "es"): "Hablamos luego, ¡adiós!",
    ("Talk to you later, bye!", "fr"): "À plus, salut !",
    ("Talk to you later, bye!", "ja"): "また後で、じゃあね!",
    ("Talk to you later, bye!", "de"): "Bis später, tschüss!",
    ("Talk to you later, bye!", "pt"): "A gente se fala, tchau!",
    ("the wifi has been down for 4 hours, fix it", "zh"): "WiFi 已经断了 4 个小时,赶紧修",
    ("the wifi has been down for 4 hours, fix it", "es"): "el wifi lleva 4 horas caído, arréglalo",
    ("the wifi has been down for 4 hours, fix it", "fr"): "le wifi est en panne depuis 4h, répare-le",
    ("the wifi has been down for 4 hours, fix it", "ja"): "WiFi が4時間止まってる、直して",
    ("the wifi has been down for 4 hours, fix it", "de"): "das WLAN ist seit 4 Stunden weg, mach es",
    ("the wifi has been down for 4 hours, fix it", "pt"): "o wifi está caído há 4 horas, conserta",
}


def gen_message_classifier(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        msg, category, conf, thought = CLASSIFIER_CASES[i % len(CLASSIFIER_CASES)]
        language = langs[i]
        style = styles[i]
        if language == "en":
            user_msg = en_styled(rng, msg, style) if style not in {"voice-asr", "broken-english"} else msg
        else:
            user_msg = CLASSIFIER_TRANSLATIONS.get((msg, language), msg)
        expected = {
            "thought": thought,
            "category": category,
            "confidence": conf,
        }
        yield build_record(
            encoder=encoder,
            task_type="message_classifier",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 6) multi_step_decision ─────────────────────────

MULTI_STEP_CASES = [
    {
        "ask": "I want to launch a podcast about AI ethics — help me get the first episode out.",
        "thought": "Three-stream plan: research/topic, recording setup, then publish + distribution. Each stream can run in parallel until publish.",
        "steps": [
            {"action": "research_topic", "description": "Pick a focused subtopic for the pilot episode and outline 5 talking points.", "depends_on": []},
            {"action": "book_guest", "description": "Identify and book one expert guest for the pilot.", "depends_on": [1]},
            {"action": "setup_recording", "description": "Pick recording software (Riverside / Zencastr) and test mic+headphones.", "depends_on": []},
            {"action": "record_episode", "description": "Record the pilot with the booked guest using the prepared setup.", "depends_on": [2, 3]},
            {"action": "edit_audio", "description": "Edit, level, and master the recording.", "depends_on": [4]},
            {"action": "publish", "description": "Upload to a podcast host (Transistor / Buzzsprout) and submit to Apple/Spotify.", "depends_on": [5]},
        ],
    },
    {
        "ask": "I want to start running 5k three times a week from zero.",
        "thought": "Couch-to-5k arc: gear + plan, build base, then schedule recurring runs.",
        "steps": [
            {"action": "buy_gear", "description": "Buy running shoes appropriate for gait and one set of running clothes.", "depends_on": []},
            {"action": "pick_plan", "description": "Choose a Couch-to-5k variant (8-9 weeks).", "depends_on": []},
            {"action": "schedule_runs", "description": "Block 3 morning slots/week on the calendar.", "depends_on": [2]},
            {"action": "log_progress", "description": "Track distance/time in a fitness app weekly.", "depends_on": [3]},
            {"action": "first_5k", "description": "Run the target 5k at the end of the plan and review.", "depends_on": [4]},
        ],
    },
    {
        "ask": "Plan a weekend trip from SF to Yosemite with my partner.",
        "thought": "Itinerary, lodging, transport, activities — sequence around lodging availability.",
        "steps": [
            {"action": "set_dates", "description": "Pick the target weekend and confirm with partner.", "depends_on": []},
            {"action": "book_lodging", "description": "Book a cabin or campsite inside / near the park.", "depends_on": [1]},
            {"action": "rent_car", "description": "Reserve a rental car for SF → Yosemite round trip.", "depends_on": [1]},
            {"action": "plan_hikes", "description": "Pick 2-3 hikes appropriate for the season and conditions.", "depends_on": [2]},
            {"action": "pack_list", "description": "Generate a packing list and gear checklist.", "depends_on": [4]},
        ],
    },
    {
        "ask": "Set up a personal CRM in Notion for tracking my freelance clients.",
        "thought": "Schema first, then DB, then templates, then automations and review cadence.",
        "steps": [
            {"action": "define_schema", "description": "List the fields: name, company, status, last contact, next step.", "depends_on": []},
            {"action": "create_database", "description": "Create the Notion database with those fields.", "depends_on": [1]},
            {"action": "build_templates", "description": "Build templates for new client and project notes.", "depends_on": [2]},
            {"action": "import_existing", "description": "Backfill current clients into the DB.", "depends_on": [2]},
            {"action": "weekly_review", "description": "Add a weekly review reminder for follow-ups.", "depends_on": [4]},
        ],
    },
    {
        "ask": "Migrate our team chat from Slack to Discord with minimal disruption.",
        "thought": "Plan / prep / cutover / cleanup. Communication is essential at each stage.",
        "steps": [
            {"action": "audit_slack", "description": "List all active channels, integrations, and DM threads worth keeping.", "depends_on": []},
            {"action": "design_discord", "description": "Map Slack channels to Discord categories + channels.", "depends_on": [1]},
            {"action": "create_discord", "description": "Set up the Discord server with roles and channels.", "depends_on": [2]},
            {"action": "announce_cutover", "description": "Announce the migration date and onboarding instructions.", "depends_on": [3]},
            {"action": "migrate_integrations", "description": "Reconfigure CI / alert webhooks to point at Discord.", "depends_on": [3]},
            {"action": "archive_slack", "description": "Archive Slack workspace after a 2-week dual-run period.", "depends_on": [4, 5]},
        ],
    },
    {
        "ask": "Help me prepare for a job interview at a senior backend role next week.",
        "thought": "Refresh + practice + logistics, in roughly that order.",
        "steps": [
            {"action": "review_jd", "description": "Re-read the job description and pull out top 5 keywords.", "depends_on": []},
            {"action": "system_design_prep", "description": "Practice 3 system design problems sized to senior backend.", "depends_on": [1]},
            {"action": "coding_drill", "description": "Solve 2 hard data-structure / algorithm problems.", "depends_on": [1]},
            {"action": "behavioral_stories", "description": "Prep 3 STAR stories for leadership and conflict.", "depends_on": [1]},
            {"action": "logistics", "description": "Test camera, mic, internet, and outfit the day before.", "depends_on": []},
        ],
    },
    {
        "ask": "Build a personal website with a blog under my domain in two weeks.",
        "thought": "Domain + stack pick, scaffold, content, deploy, polish.",
        "steps": [
            {"action": "buy_domain", "description": "Register the desired domain.", "depends_on": []},
            {"action": "pick_stack", "description": "Pick a static-site framework (Astro / Next.js / Hugo).", "depends_on": []},
            {"action": "scaffold_site", "description": "Scaffold the site with the chosen framework and a base theme.", "depends_on": [2]},
            {"action": "write_posts", "description": "Draft 3 starter blog posts.", "depends_on": [3]},
            {"action": "deploy", "description": "Deploy to Vercel / Netlify and connect the domain.", "depends_on": [1, 4]},
            {"action": "analytics", "description": "Add lightweight analytics and an RSS feed.", "depends_on": [5]},
        ],
    },
    {
        "ask": "I want to switch to a vegetarian diet over the next month.",
        "thought": "Nutrition baseline, recipe library, gradual swap, monitor.",
        "steps": [
            {"action": "consult_nutrition", "description": "Identify protein, iron, B12 sources to plan around.", "depends_on": []},
            {"action": "build_meal_plan", "description": "Plan a 7-day rotating vegetarian meal plan.", "depends_on": [1]},
            {"action": "groceries", "description": "Stock pantry with staples and produce.", "depends_on": [2]},
            {"action": "cook_and_log", "description": "Cook meals and log how I feel for 4 weeks.", "depends_on": [3]},
            {"action": "review", "description": "Review at week 4: any deficiencies or struggles?", "depends_on": [4]},
        ],
    },
    {
        "ask": "Plan a remote birthday party for my brother across 3 time zones.",
        "thought": "Coordinate time, platform, agenda, gifts, capture.",
        "steps": [
            {"action": "pick_time", "description": "Pick a slot acceptable in all 3 time zones.", "depends_on": []},
            {"action": "send_invites", "description": "Send invites with calendar holds.", "depends_on": [1]},
            {"action": "pick_platform", "description": "Pick Zoom / Meet / Discord with breakout support.", "depends_on": []},
            {"action": "agenda", "description": "Plan a 60-minute agenda with games and toasts.", "depends_on": [3]},
            {"action": "gift_logistics", "description": "Coordinate a group gift and shipping.", "depends_on": [2]},
            {"action": "record_message", "description": "Collect short video messages from family for a montage.", "depends_on": [2]},
        ],
    },
    {
        "ask": "Set up a home gym in my garage on a $1000 budget.",
        "thought": "Space, equipment list, budget allocation, install, first workout.",
        "steps": [
            {"action": "measure_space", "description": "Measure usable area and check ceiling/floor constraints.", "depends_on": []},
            {"action": "essential_list", "description": "Build an MVP list: rack, bar, plates, bench.", "depends_on": [1]},
            {"action": "allocate_budget", "description": "Allocate the $1000 across the list with new vs used.", "depends_on": [2]},
            {"action": "purchase", "description": "Buy items, prefer used local for big items.", "depends_on": [3]},
            {"action": "install_floor", "description": "Lay rubber mats and confirm rack stability.", "depends_on": [4]},
            {"action": "first_workout", "description": "Do a baseline workout and adjust placement.", "depends_on": [5]},
        ],
    },
    {
        "ask": "I want to move from contractor to FTE; help me negotiate.",
        "thought": "Research, anchor, conversation, decision.",
        "steps": [
            {"action": "research_ranges", "description": "Pull Levels.fyi / Glassdoor for the target role at this company.", "depends_on": []},
            {"action": "set_targets", "description": "Set a target, walk-away, and ideal package.", "depends_on": [1]},
            {"action": "draft_pitch", "description": "Draft talking points for the conversion conversation.", "depends_on": [2]},
            {"action": "schedule_meeting", "description": "Schedule the conversation with the hiring manager.", "depends_on": [3]},
            {"action": "negotiate", "description": "Run the conversation, handle counters, finalize.", "depends_on": [4]},
        ],
    },
    {
        "ask": "I'd like to learn Spanish to a B1 level in 6 months.",
        "thought": "Daily practice + structured course + speaking time.",
        "steps": [
            {"action": "pick_app", "description": "Pick a structured app (Pimsleur / Babbel) and commit 20 min/day.", "depends_on": []},
            {"action": "vocab_anki", "description": "Build an Anki deck for top 1000 words and review daily.", "depends_on": [1]},
            {"action": "weekly_tutor", "description": "Book a weekly italki tutor for conversation.", "depends_on": []},
            {"action": "consume_media", "description": "Add 2 hours/week of Spanish podcast / TV input.", "depends_on": []},
            {"action": "checkpoint", "description": "At month 3, take a placement test to confirm B1 trajectory.", "depends_on": [1, 2, 3, 4]},
        ],
    },
    {
        "ask": "Sell my old laptop and buy a new one within budget.",
        "thought": "Value/sell first to know budget; pick new model; transfer + dispose.",
        "steps": [
            {"action": "appraise_old", "description": "Check Swappa / eBay completed listings for resale value.", "depends_on": []},
            {"action": "list_old", "description": "List the laptop on Swappa / FB Marketplace.", "depends_on": [1]},
            {"action": "pick_new", "description": "Pick a new model based on remaining budget after sale.", "depends_on": [1]},
            {"action": "buy_new", "description": "Buy the new laptop.", "depends_on": [3]},
            {"action": "transfer_data", "description": "Migrate data and apps to the new laptop.", "depends_on": [4]},
            {"action": "wipe_and_ship", "description": "Wipe old laptop and ship to buyer.", "depends_on": [2, 5]},
        ],
    },
    {
        "ask": "I want to apply to grad school in Computer Science for fall.",
        "thought": "Research → list → standardized tests → letters → essays → submission.",
        "steps": [
            {"action": "research_programs", "description": "Identify programs aligned with my research interests.", "depends_on": []},
            {"action": "shortlist", "description": "Shortlist 8-10 programs and note deadlines.", "depends_on": [1]},
            {"action": "gre_or_skip", "description": "Confirm GRE requirement and book test if needed.", "depends_on": [2]},
            {"action": "request_letters", "description": "Request 3 letters of recommendation.", "depends_on": [2]},
            {"action": "write_sop", "description": "Draft a tailored Statement of Purpose for each program.", "depends_on": [2]},
            {"action": "submit", "description": "Submit applications before each deadline.", "depends_on": [3, 4, 5]},
        ],
    },
    {
        "ask": "Help me automate my morning routine.",
        "thought": "Audit → identify automations → install → schedule.",
        "steps": [
            {"action": "audit_morning", "description": "List the morning steps and time spent on each.", "depends_on": []},
            {"action": "find_automations", "description": "Identify 2-3 high-leverage automations (lights, coffee, briefing).", "depends_on": [1]},
            {"action": "install_devices", "description": "Buy + install required smart devices.", "depends_on": [2]},
            {"action": "set_routines", "description": "Configure routines in HomeKit / Home Assistant.", "depends_on": [3]},
            {"action": "iterate", "description": "Review after a week and refine.", "depends_on": [4]},
        ],
    },
]

MULTISTEP_LANG_PREFIX = {
    "zh": "请帮我:",
    "es": "Por favor ayúdame:",
    "fr": "Aide-moi s'il te plaît :",
    "ja": "お願いします:",
    "de": "Bitte hilf mir:",
    "pt": "Por favor me ajuda:",
}


def gen_multi_step_decision(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = MULTI_STEP_CASES[i % len(MULTI_STEP_CASES)]
        language = langs[i]
        style = styles[i]
        ask = case["ask"]
        if language == "en":
            user_msg = en_styled(rng, ask, style)
        else:
            user_msg = f"{MULTISTEP_LANG_PREFIX[language]} {ask}"
        steps_out = []
        for idx, st in enumerate(case["steps"], start=1):
            steps_out.append({
                "step": idx,
                "action": st["action"],
                "description": st["description"],
                "depends_on": list(st["depends_on"]),
            })
        expected = {
            "thought": case["thought"],
            "steps": steps_out,
        }
        yield build_record(
            encoder=encoder,
            task_type="multi_step_decision",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 7) add_contact ─────────────────────────────────

ADD_CONTACT_CASES = [
    {
        "msg": "Save Sarah Mitchell, sarah.m@acme.com, my new account manager at Acme.",
        "name": "Sarah Mitchell", "phone": "", "email": "sarah.m@acme.com",
        "relationship": "account manager", "notes": "Account manager at Acme.",
        "thought": "User asked to save a new contact with name, email, and role; no phone provided.",
    },
    {
        "msg": "Add my dad John Park 415-555-0123 john.park@gmail.com",
        "name": "John Park", "phone": "415-555-0123", "email": "john.park@gmail.com",
        "relationship": "father", "notes": "User's dad.",
        "thought": "Family contact; full name, phone, email all present, relationship = father.",
    },
    {
        "msg": "Add Marcus the dog walker, 510-555-7788. He comes Tue/Thu.",
        "name": "Marcus", "phone": "510-555-7788", "email": "",
        "relationship": "dog walker", "notes": "Comes Tue/Thu.",
        "thought": "Service contact; phone given but no email; schedule note included.",
    },
    {
        "msg": "Save my doctor — Dr. Aisha Patel, office line 213-555-9090.",
        "name": "Dr. Aisha Patel", "phone": "213-555-9090", "email": "",
        "relationship": "doctor", "notes": "Office line.",
        "thought": "Medical contact, name + office phone, no email.",
    },
    {
        "msg": "New contact: Tom Wong, lives next door, no number yet.",
        "name": "Tom Wong", "phone": "", "email": "",
        "relationship": "neighbor", "notes": "Lives next door, no number yet.",
        "thought": "Neighbor with name only; phone and email both unknown.",
    },
    {
        "msg": "Save Lila Bennett — lila@studio.io — she's a freelance designer I work with.",
        "name": "Lila Bennett", "phone": "", "email": "lila@studio.io",
        "relationship": "designer", "notes": "Freelance designer.",
        "thought": "Professional contact, email and role; no phone.",
    },
    {
        "msg": "Add my landlord Mrs. Chen, 415-555-2020, available Mon-Fri.",
        "name": "Mrs. Chen", "phone": "415-555-2020", "email": "",
        "relationship": "landlord", "notes": "Available Mon-Fri.",
        "thought": "Housing contact; honorific kept; phone + availability noted.",
    },
    {
        "msg": "Add Daniel Park, daniel.park@stripe.com, my eng manager.",
        "name": "Daniel Park", "phone": "", "email": "daniel.park@stripe.com",
        "relationship": "manager", "notes": "Engineering manager at Stripe.",
        "thought": "Work contact, email + role at known employer.",
    },
    {
        "msg": "Save Aunt Nadia, +44 20 7946 0123 — calls me every Sunday.",
        "name": "Aunt Nadia", "phone": "+44 20 7946 0123", "email": "",
        "relationship": "family",
        "notes": "Aunt; calls every Sunday.",
        "thought": "Family contact with international phone and a recurring habit note.",
    },
    {
        "msg": "Add Mike from gym — 312-555-0044 — spotter buddy.",
        "name": "Mike", "phone": "312-555-0044", "email": "",
        "relationship": "gym friend", "notes": "Spotter buddy from gym.",
        "thought": "Casual gym contact; first name only; phone + activity note.",
    },
    {
        "msg": "Save Priya Reddy, priya@founders.club — she's an investor I met at AngelList.",
        "name": "Priya Reddy", "phone": "", "email": "priya@founders.club",
        "relationship": "investor", "notes": "Met at AngelList.",
        "thought": "Investor contact, email + sourcing note.",
    },
    {
        "msg": "Add my plumber Carlos Ruiz, 408-555-7711.",
        "name": "Carlos Ruiz", "phone": "408-555-7711", "email": "",
        "relationship": "plumber", "notes": "Plumber.",
        "thought": "Service contact with name + phone.",
    },
    {
        "msg": "New contact — Nora, my realtor, nora.kim@redfin.com / 206-555-1234.",
        "name": "Nora Kim", "phone": "206-555-1234", "email": "nora.kim@redfin.com",
        "relationship": "realtor", "notes": "Realtor at Redfin.",
        "thought": "Realtor contact; full name reconstructed from email; phone + email both present.",
    },
    {
        "msg": "Add my college roommate, Jaden Wright, dm me on Twitter @jadenw",
        "name": "Jaden Wright", "phone": "", "email": "",
        "relationship": "college roommate", "notes": "Twitter @jadenw.",
        "thought": "Personal contact, no email/phone, social handle stored as a note.",
    },
    {
        "msg": "Save Eva Lindgren, eva.l@hej.se, my Swedish tutor — meets Wednesdays.",
        "name": "Eva Lindgren", "phone": "", "email": "eva.l@hej.se",
        "relationship": "tutor", "notes": "Swedish tutor; meets Wednesdays.",
        "thought": "Tutor contact, email + recurring schedule note.",
    },
]

ADDCONTACT_LANG_PREFIX = {
    "zh": "添加联系人:",
    "es": "Añade un contacto:",
    "fr": "Ajoute un contact :",
    "ja": "連絡先を追加:",
    "de": "Füge einen Kontakt hinzu:",
    "pt": "Adiciona um contato:",
}


def gen_add_contact(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = ADD_CONTACT_CASES[i % len(ADD_CONTACT_CASES)]
        language = langs[i]
        style = styles[i]
        if language == "en":
            user_msg = en_styled(rng, case["msg"], style)
        else:
            # Keep contact details verbatim; translate the lead-in only.
            user_msg = f"{ADDCONTACT_LANG_PREFIX[language]} {case['msg']}"
        expected = {
            "thought": case["thought"],
            "name": case["name"],
            "phone": case["phone"],
            "email": case["email"],
            "relationship": case["relationship"],
            "notes": case["notes"],
        }
        yield build_record(
            encoder=encoder,
            task_type="add_contact",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── 8) should_follow_room ──────────────────────────

FOLLOW_ROOM_CASES = [
    {
        "msg": "follow this room",
        "should_follow": True,
        "thought": "Explicit user instruction to follow.",
        "reason": "User directly asked the agent to follow the room.",
    },
    {
        "msg": "I want you to keep tabs on what's happening here even when I'm not pinging you",
        "should_follow": True,
        "thought": "User explicitly wants ambient monitoring of this room.",
        "reason": "Ambient monitoring requested.",
    },
    {
        "msg": "stop watching this channel",
        "should_follow": False,
        "thought": "User asked to stop following.",
        "reason": "Direct unfollow instruction; should_follow=false.",
    },
    {
        "msg": "this room is mostly people I don't know — don't bother",
        "should_follow": False,
        "thought": "User signaled the room is low-relevance and not worth following.",
        "reason": "Low signal; user wants the agent disengaged.",
    },
    {
        "msg": "this is the engineering planning room, you'll want to keep up",
        "should_follow": True,
        "thought": "User identifies this as a high-signal planning room and signals continued engagement.",
        "reason": "High-signal planning room; user wants ongoing visibility.",
    },
    {
        "msg": "you can chill here, I'll @ you when I need you",
        "should_follow": False,
        "thought": "User explicitly disabled background engagement and prefers explicit pings.",
        "reason": "User prefers ping-driven engagement only.",
    },
    {
        "msg": "this is a private one-on-one with my therapist — please don't follow",
        "should_follow": False,
        "thought": "Sensitive private room; user explicitly opted out of the agent following.",
        "reason": "Sensitive context; user opted out.",
    },
    {
        "msg": "follow this room and summarize daily",
        "should_follow": True,
        "thought": "User requested follow + a summarization side-effect.",
        "reason": "Daily summary request implies the agent should follow.",
    },
    {
        "msg": "leave this room alone",
        "should_follow": False,
        "thought": "User explicitly asked the agent to disengage.",
        "reason": "Explicit disengagement.",
    },
    {
        "msg": "stay tuned in here, things move fast",
        "should_follow": True,
        "thought": "User explicitly asked for ongoing engagement.",
        "reason": "User asked for sustained attention.",
    },
    {
        "msg": "we've moved discussion to another channel, you can ignore this one now",
        "should_follow": False,
        "thought": "Topic moved elsewhere; this room is now low-signal.",
        "reason": "Topic relocated; current room low-signal.",
    },
    {
        "msg": "this is the standup channel and I want you in the loop",
        "should_follow": True,
        "thought": "Standup channel + explicit visibility request.",
        "reason": "Standup channel; user wants the agent looped in.",
    },
    {
        "msg": "actually unfollow this room — too noisy",
        "should_follow": False,
        "thought": "Noise complaint and explicit unfollow request.",
        "reason": "User cited noise and asked to unfollow.",
    },
    {
        "msg": "make this one of your tracked rooms",
        "should_follow": True,
        "thought": "User explicitly added this room to the tracked set.",
        "reason": "Explicit track-this-room signal.",
    },
    {
        "msg": "the convo here is just memes, no real signal",
        "should_follow": False,
        "thought": "Low-signal social channel; not worth ambient follow.",
        "reason": "Pure social/memes; low signal.",
    },
]

FOLLOW_TRANSLATIONS = {
    ("follow this room", "zh"): "关注这个房间",
    ("follow this room", "es"): "sigue esta sala",
    ("follow this room", "fr"): "suis cette salle",
    ("follow this room", "ja"): "このルームをフォローして",
    ("follow this room", "de"): "folge diesem Raum",
    ("follow this room", "pt"): "siga esta sala",
    ("stop watching this channel", "zh"): "不要再关注这个频道了",
    ("stop watching this channel", "es"): "deja de seguir este canal",
    ("stop watching this channel", "fr"): "arrête de suivre ce canal",
    ("stop watching this channel", "ja"): "このチャンネルを見るのをやめて",
    ("stop watching this channel", "de"): "hör auf, diesen Kanal zu beobachten",
    ("stop watching this channel", "pt"): "pare de acompanhar este canal",
    ("leave this room alone", "zh"): "别管这个房间",
    ("leave this room alone", "es"): "déjame esta sala en paz",
    ("leave this room alone", "fr"): "laisse cette salle tranquille",
    ("leave this room alone", "ja"): "このルームには関わらないで",
    ("leave this room alone", "de"): "lass diesen Raum in Ruhe",
    ("leave this room alone", "pt"): "deixe esta sala quieta",
    ("follow this room and summarize daily", "zh"): "关注这个房间并每天做总结",
    ("follow this room and summarize daily", "es"): "sigue esta sala y resume a diario",
    ("follow this room and summarize daily", "fr"): "suis cette salle et fais un résumé quotidien",
    ("follow this room and summarize daily", "ja"): "このルームをフォローして毎日まとめて",
    ("follow this room and summarize daily", "de"): "folge diesem Raum und fasse täglich zusammen",
    ("follow this room and summarize daily", "pt"): "siga esta sala e resuma diariamente",
    ("stay tuned in here, things move fast", "zh"): "在这里保持关注,这里节奏很快",
    ("stay tuned in here, things move fast", "es"): "mantente atento aquí, las cosas se mueven rápido",
    ("stay tuned in here, things move fast", "fr"): "reste attentif ici, ça bouge vite",
    ("stay tuned in here, things move fast", "ja"): "ここで注目し続けて、動きが速いから",
    ("stay tuned in here, things move fast", "de"): "bleib hier dran, hier geht's schnell",
    ("stay tuned in here, things move fast", "pt"): "fique atento aqui, as coisas se movem rápido",
}


def gen_should_follow_room(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict[str, Any]]:
    langs = language_plan(n, rng)
    styles = style_plan(n, rng)
    for i in range(n):
        case = FOLLOW_ROOM_CASES[i % len(FOLLOW_ROOM_CASES)]
        language = langs[i]
        style = styles[i]
        if language == "en":
            user_msg = en_styled(rng, case["msg"], style)
        else:
            user_msg = FOLLOW_TRANSLATIONS.get((case["msg"], language), case["msg"])
        expected = {
            "thought": case["thought"],
            "should_follow": case["should_follow"],
            "reason": case["reason"],
        }
        yield build_record(
            encoder=encoder,
            task_type="should_follow_room",
            user_msg=user_msg,
            expected_obj=expected,
            rng=rng,
            memory_snippet=pick_memory(rng),
            language=language,
            style=style,
        )


# ─────────────────────────── driver ────────────────────────────────────────

GENERATORS: list[tuple[str, Callable[[ExpectedResponseEncoder, random.Random, int], Iterable[dict[str, Any]]]]] = [
    ("reflection", gen_reflection),
    ("reflection_evaluator", gen_reflection_evaluator),
    ("extract_secrets", gen_extract_secrets),
    ("choose_option", gen_choose_option),
    ("message_classifier", gen_message_classifier),
    ("multi_step_decision", gen_multi_step_decision),
    ("add_contact", gen_add_contact),
    ("should_follow_room", gen_should_follow_room),
]


def write_jsonl(records: Iterable[dict[str, Any]], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
            n += 1
    return n


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-task", type=int, default=100)
    parser.add_argument("--seed", type=int, default=0xC0FFEE5)
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    encoder = JsonExpectedResponseEncoder()
    rng = random.Random(args.seed)

    counts: dict[str, int] = {}
    for task_id, gen in GENERATORS:
        sub_rng = random.Random(rng.randrange(1 << 31))
        out_path = OUT_DIR / f"{task_id}.jsonl"
        records = list(gen(encoder, sub_rng, args.per_task))
        wrote = write_jsonl(records, out_path)
        counts[task_id] = wrote
        log.info("[%s] %d records → %s", task_id, wrote, out_path)

    encoder.close()
    log.info("done. counts: %s", counts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
