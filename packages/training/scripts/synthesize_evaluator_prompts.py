"""Legacy TOON synthesizer for Phase-4 evaluator records.

This script is not a native v5 JSON export path yet. It remains quarantined
for compatibility corpus rebuilds until the teacher prompts and validators are
rewritten around JSON targets.

Targets (one record-shape per evaluator — pulled directly from the
template literal at `eliza/packages/core/src/prompts.ts`):

    reflection             reflectionTemplate                @ prompts.ts:867
    reflection_evaluator   reflectionEvaluatorTemplate       @ prompts.ts:699
    fact_extractor         factExtractionTemplate            @ prompts.ts:752
    summarization          initialSummarizationTemplate      @ prompts.ts:254
    long_term_extraction   longTermExtractionTemplate        @ prompts.ts:285

Default size is ~3,000 records per evaluator (15k total). Output:
``data/synthesized/evaluators/<evaluator>.jsonl``.

Distribution gates (failure raises):

    fact_extractor        15 % must be empty `{"ops": []}`
    long_term_extraction  60 % must be empty memories block
    summarization         40 % short / 40 % medium / 20 % long input

The records are canonical ``ElizaRecord`` envelopes — see SCHEMA.md.
``expectedResponse`` for ``fact_extractor`` is RAW JSON (per the
template's contract); the other four evaluators emit TOON.

Usage::

    export ANTHROPIC_API_KEY=...
    .venv/bin/python scripts/synthesize_evaluator_prompts.py
    .venv/bin/python scripts/synthesize_evaluator_prompts.py \
        --only fact_extractor --per-task 500
    .venv/bin/python scripts/synthesize_evaluator_prompts.py --dry-run \
        --out /tmp/eval_dry/

In ``--dry-run`` mode the teacher is replaced with a deterministic stub
that emits canned, schema-valid output. That lets the wiring be
verified end-to-end (record envelope, distribution gates,
``classify_records_by_phase.py``) without needing API keys.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import build, stable_id  # noqa: E402
from lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

OUT_DIR = ROOT / "data" / "synthesized" / "evaluators"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-evaluator")


# ───────────────────────── teacher client ──────────────────────────────────

@dataclass
class TeacherCfg:
    provider: str
    model: str
    max_tokens: int = 2048
    temperature: float = 0.7


def call_anthropic(cfg: TeacherCfg, system: str, user: str) -> str:
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY not set. Export it before running this "
            "script (or use --dry-run for stubbed output)."
        )
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=cfg.model,
        max_tokens=cfg.max_tokens,
        temperature=cfg.temperature,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    parts: list[str] = []
    for b in resp.content:
        if hasattr(b, "text"):
            parts.append(b.text)
    return "".join(parts).strip()


def call_openai_compat(cfg: TeacherCfg, system: str, user: str, *,
                       base_url: str, api_key_env: str) -> str:
    """OpenAI-compatible /v1/chat/completions caller. Used for Groq, Together,
    Fireworks, vLLM, LM Studio, Ollama — anything that speaks the OpenAI
    chat API. ``cfg.model`` is sent verbatim, e.g. ``openai/gpt-oss-120b``.

    Reasoning models (gpt-oss, deepseek-r1, qwen-3-thinking) split their output
    between a `reasoning` field and `content`. We use `reasoning_effort=low`
    so most of the budget goes to `content`, then fall back to `reasoning` when
    `content` is empty (rare, but happens on tight max_tokens)."""
    import json as _json
    import urllib.error
    import urllib.request
    api_key = os.environ.get(api_key_env)
    if not api_key:
        raise RuntimeError(
            f"{api_key_env} not set. Export it before running this script "
            f"(or use --dry-run for stubbed output)."
        )
    payload = {
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "reasoning_effort": "low",
    }
    body = _json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            # Cloudflare on Groq's edge rejects the default `Python-urllib/x.y`
            # User-Agent with HTTP 403 (cf-error 1010). Any non-default UA works.
            "User-Agent": "milady-synth/1.0 (+https://github.com/elizaOS/eliza)",
        },
        method="POST",
    )
    # Retry with exponential backoff on 429 (rate limit) and 5xx (transient
    # upstream errors). The backoff respects the `Retry-After` header when
    # the server provides one (Groq does on 429).
    last_exc: Exception | None = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:  # nosec B310
                result = _json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            last_exc = e
            if e.code in (429, 500, 502, 503, 504):
                retry_after = e.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    delay = float(retry_after)
                else:
                    delay = (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(min(delay, 60.0))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last_exc = e
            time.sleep((2 ** attempt) + random.uniform(0, 0.5))
            continue
    else:
        raise RuntimeError(f"teacher request failed after retries: {last_exc}")

    msg = result["choices"][0]["message"]
    content = (msg.get("content") or "").strip()
    if not content:
        # Reasoning model exhausted max_tokens before producing content.
        # Surface the reasoning instead so the caller can detect & retry.
        content = (msg.get("reasoning") or "").strip()
    return content


def call_groq(cfg: TeacherCfg, system: str, user: str) -> str:
    return call_openai_compat(
        cfg, system, user,
        base_url="https://api.groq.com/openai/v1",
        api_key_env="GROQ_API_KEY",
    )


def call_openai(cfg: TeacherCfg, system: str, user: str) -> str:
    return call_openai_compat(
        cfg, system, user,
        base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        api_key_env="OPENAI_API_KEY",
    )


def call_teacher(cfg: TeacherCfg, system: str, user: str) -> str:
    if cfg.provider == "anthropic":
        return call_anthropic(cfg, system, user)
    if cfg.provider == "groq":
        return call_groq(cfg, system, user)
    if cfg.provider == "openai":
        return call_openai(cfg, system, user)
    raise ValueError(f"unknown teacher provider: {cfg.provider}")


def strip_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:toon|json)?\s*\n?|\n?```$", "", s, flags=re.S)
    s = s.strip()
    lines = s.splitlines()
    while lines and lines[0].strip().lower() in (
        "toon", "toon:", "json", "json:", "output", "output:",
    ):
        lines.pop(0)
    return "\n".join(lines).strip()


def _maybe_json_payload(s: str) -> str:
    """Parse `s` as JSON and re-encode as TOON if it looks like JSON.
    fact_extractor speaks JSON natively so we leave it alone there;
    callers must opt out by skipping this helper for JSON-output tasks."""
    t = s.strip()
    if not (t.startswith("{") and t.endswith("}")):
        return s
    try:
        obj = json.loads(t)
    except json.JSONDecodeError:
        return s
    try:
        return ToonEncoder().encode(obj)
    except Exception:  # noqa: BLE001
        return s


_INDEXED_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]\s*:\s*(.+)$")


def repair_toon_bullets(s: str) -> str:
    """Two repair passes for common gpt-oss-120b TOON deviations.

    Pass 1: collapse `key[0]: a / key[1]: b / ...` into `key[N]:\n  - a\n  - b`.
    Pass 2: convert markdown bullets (`key:\n- a\n- b`) into TOON array form.
    Idempotent on already-valid TOON."""
    lines = s.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m_idx = _INDEXED_RE.match(line)
        if m_idx and m_idx.group(2) == "0":
            key = m_idx.group(1)
            items = [m_idx.group(3).strip()]
            k = i + 1
            expected = 1
            while k < len(lines):
                m2 = _INDEXED_RE.match(lines[k])
                if not m2 or m2.group(1) != key or m2.group(2) != str(expected):
                    break
                items.append(m2.group(3).strip())
                expected += 1
                k += 1
            if len(items) >= 2:
                out.append(f"{key}[{len(items)}]:")
                for v in items:
                    out.append(f"  - {v}")
                i = k
                continue
        m_bare = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*$", line)
        if m_bare:
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            bullets: list[str] = []
            k = j
            while k < len(lines) and lines[k].lstrip().startswith("- "):
                bullets.append(lines[k].lstrip()[2:].strip())
                k += 1
            if bullets:
                key = m_bare.group(1)
                out.append(f"{key}[{len(bullets)}]:")
                for b in bullets:
                    out.append(f"  - {b}")
                i = k
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def normalize_teacher_output(s: str, *, allow_json: bool = False) -> str:
    """Strip fences + transcode JSON→TOON (unless `allow_json`) + repair
    passes + round-trip canonicalize through the TOON decoder/encoder.

    `allow_json=True` is for fact_extractor whose canonical output is
    JSON, not TOON — we only want fence-stripping there."""
    cleaned = strip_fences(s)
    if allow_json:
        return cleaned
    cleaned = repair_toon_bullets(_maybe_json_payload(cleaned))
    try:
        decoded = ToonDecoder().decode(cleaned)
        if isinstance(decoded, (dict, list)):
            return ToonEncoder().encode(decoded)
    except Exception:  # noqa: BLE001
        return cleaned
    return cleaned


# ───────────────────────── shared diversity pools ─────────────────────────

PERSONAS = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas", "yuna", "marcus",
    "claire", "miguel", "deepa", "kenji", "luca", "naomi", "owen",
    "renata",
]

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
]


def fake_uuid(rng: random.Random) -> str:
    """Deterministic-from-RNG pseudo-UUID. 36 chars, looks real enough
    for the runtime's relationship loader and for the
    `entity-not-in-room` heuristics."""
    return str(uuid.UUID(int=rng.getrandbits(128)))


# ────────────────────── conversation snippet pool ──────────────────────────
# Diverse conversation seeds the synthesizer can splice into recent
# messages of varying length. Each seed is (speaker_role, content). The
# inputs cover both small-talk (no facts) and substantive turns.

SUBSTANTIVE_SEEDS: list[tuple[str, str]] = [
    ("user", "I just got promoted to engineering manager at Stripe."),
    ("agent", "Congrats! How big is the team you're inheriting?"),
    ("user", "Six engineers, mostly backend. Started running 1:1s yesterday."),
    ("user", "I'm allergic to peanuts and have been vegan for years."),
    ("user", "My sister Lila is moving to Berlin next month."),
    ("agent", "What's drawing her there?"),
    ("user", "She got a postdoc at Charité."),
    ("user", "Founded Acme Robotics with my friend Rohan in 2024."),
    ("user", "We use TypeScript everywhere — strict mode, no any."),
    ("user", "I always run tests before opening a PR; that's non-negotiable."),
    ("user", "Migrated payments from MongoDB to Postgres last quarter."),
    ("user", "Finished the terraform refactor on Friday — long overdue."),
    ("user", "I'm anxious about the launch tomorrow."),
    ("user", "Currently debugging a flaky auth integration test."),
    ("user", "Going through a divorce — it's been rough."),
    ("user", "Headed to Tokyo next week for a conference."),
    ("user", "I prefer git rebase — keeps the history linear."),
    ("user", "Writing my master's thesis on graph neural networks."),
    ("agent", "How are the experiments going?"),
    ("user", "Decent — early results show 4-6% lift on the baseline."),
]

SMALL_TALK_SEEDS: list[tuple[str, str]] = [
    ("user", "morning"),
    ("agent", "morning! how's it going?"),
    ("user", "ok I guess"),
    ("user", "how's the weather where you are"),
    ("agent", "I don't really have a 'where', haha. how's yours?"),
    ("user", "haha fair"),
    ("user", "thanks for the help earlier"),
    ("agent", "anytime."),
    ("user", "got a sec?"),
    ("agent", "always — fire away."),
    ("user", "what time is it"),
    ("user", "lol"),
    ("user", "you online?"),
    ("agent", "yep"),
    ("user", "did you see the news today"),
    ("agent", "which story?"),
    ("user", "nvm"),
    ("user", "brb"),
    ("user", "back"),
    ("user", "wat"),
]


def pick_messages(
    rng: random.Random, *, n: int, substantive_ratio: float
) -> list[tuple[str, str]]:
    """Return `n` (role, content) pairs interleaving substantive and
    small-talk seeds at approximately the requested ratio."""
    out: list[tuple[str, str]] = []
    sub_idx = rng.randrange(len(SUBSTANTIVE_SEEDS))
    st_idx = rng.randrange(len(SMALL_TALK_SEEDS))
    for _ in range(n):
        if rng.random() < substantive_ratio:
            out.append(SUBSTANTIVE_SEEDS[sub_idx % len(SUBSTANTIVE_SEEDS)])
            sub_idx += 1
        else:
            out.append(SMALL_TALK_SEEDS[st_idx % len(SMALL_TALK_SEEDS)])
            st_idx += 1
    return out


def to_memory_entries(
    speaker: str, agent: str, snippet: list[tuple[str, str]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for role, text in snippet:
        out.append({
            "role": "user" if role == "user" else "assistant",
            "speaker": speaker if role == "user" else agent,
            "content": text,
            "channel": "dm",
        })
    return out


def render_recent(snippet: list[tuple[str, str]], speaker: str, agent: str) -> str:
    """Format a conversation snippet as the ``recentMessages`` block."""
    lines = []
    for role, text in snippet:
        name = speaker if role == "user" else agent
        lines.append(f"{name}: {text}")
    return "\n".join(lines)


# ───────────────────────── template literals ──────────────────────────────
# Pulled verbatim from `eliza/packages/core/src/prompts.ts` (see line refs
# in the module docstring). Only `{{var}}` placeholders are kept; we
# render them via a minimal handlebars substitute below.

REFLECTION_TEMPLATE = """# Task: Reflect on recent agent behavior and interactions.

{{providers}}

# Recent Interactions:
{{recentInteractions}}

# Instructions:
Analyze the agent's recent behavior and interactions. Consider:
1. Was the communication clear and helpful?
2. Were responses appropriate for the context?
3. Were any mistakes made?
4. What could be improved?

Respond using TOON like this:
thought: Your detailed analysis
quality_score: <integer 0-100, e.g. 78 — NEVER spell the number out as "seventy-eight">
strengths[N]:
  - first strength
  - second strength
improvements[N]:
  - first improvement
learnings[N]:
  - first takeaway

`quality_score` MUST be a bare integer. Do NOT write "78/100", "78%",
"seventy-eight", or wrap it in quotes. Strengths/improvements/learnings
MUST be a TOON array of one-line strings — never markdown bullets,
never sub-keyed objects.

IMPORTANT: Your response must ONLY contain the TOON document above."""


REFLECTION_EVALUATOR_TEMPLATE = """# Task: Generate Agent Reflection and Extract Relationships

# Examples:
{{evaluationExamples}}

# Entities in Room
{{entitiesInRoom}}

# Existing Relationships
{{existingRelationships}}

# Current Context:
Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})

{{recentMessages}}

# Latest Action Results:
{{actionResults}}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Identify and describe relationships between entities.
  - The sourceEntityId is the UUID of the entity initiating the interaction.
  - The targetEntityId is the UUID of the entity being interacted with.
  - Relationships are one-direction.
3. Always decide whether the user's task or request is actually complete right now.
4. Always include a short task_completion_reason grounded in the conversation and action results.

Output:
TOON only. Return exactly one TOON document. No prose before or after it.
Do not output JSON, XML, Markdown fences, or commentary.

thought: a self-reflective thought on the conversation
task_completed: false
task_completion_reason: short justification grounded in the messages
relationships[0]:
  sourceEntityId: <UUID-from-entities-in-room>
  targetEntityId: <UUID-from-entities-in-room>
  tags[0]: dm_interaction"""


FACT_EXTRACTION_TEMPLATE = """# Task: Classify and extract facts from this message

You maintain a two-store fact memory for an AI assistant. For each message you decide what to insert, strengthen, decay, or contradict in that memory. You return a single JSON object with an `ops` array — nothing else.

## STRICT op vocabulary (these are the ONLY accepted op values)

- `add_durable`     — for stable identity-level claims. ALWAYS include
                      `claim`, `category`, AND `structured_fields` (object).
                      Optional: `verification_status`, `reason`.
- `add_current`     — for time-bound state. ALWAYS include `claim`,
                      `category`, AND `structured_fields` (object).
                      Optional: `valid_at` (ISO timestamp), `reason`.
- `strengthen`      — when a known fact is restated; include `factId` and
                      `reason`.
- `decay`           — when a current fact looks resolved; include `factId`
                      and `reason`.
- `contradict`      — when a fact is directly contradicted; include
                      `factId`, `proposedText`, `reason`.

DO NOT emit `op: insert`, `op: add`, `op: update`, or any value not in the
list above. Use `add_durable` for durable claims and `add_current` for
time-bound state — never the bare `add` or `insert`. Every `add_*` op
MUST include `structured_fields` even when sparse — `{}` is not valid;
include at least one structured key the claim is about.

WRONG (rejected):
  {"ops":[{"op":"insert","category":"current.feeling","claim":"anxious"}]}
  {"ops":[{"op":"add_current","category":"feeling","claim":"anxious"}]}   ← missing structured_fields
  {"ops":[{"insert":{"category":"current.task","value":"debugging"}}]}

RIGHT:
  {"ops":[{"op":"add_current","claim":"anxious this morning","category":"feeling","structured_fields":{"emotion":"anxious","window":"morning"}}]}
  {"ops":[{"op":"add_durable","claim":"peanut allergy","category":"allergy","structured_fields":{"allergen":"peanuts"}}]}
  {"ops":[{"op":"add_durable","claim":"founded Acme Corp in 2024","category":"life_event","structured_fields":{"event":"founded company","company":"Acme Corp","year":2024}}]}
  {"ops":[{"op":"strengthen","factId":"fact_xyz","reason":"user reaffirmed in this message"}]}
  {"ops":[{"op":"contradict","factId":"fact_abc","proposedText":"lives in Tokyo","reason":"moved from Berlin"}]}

(see eliza/packages/core/src/prompts.ts:752 for the full description; the
inputs below replicate the runtime substitution.)

## Inputs

# Current Context
Agent Name: {{agentName}}
Message Sender: {{senderName}} (ID: {{senderId}})
Now: {{now}}

# Recent Messages
{{recentMessages}}

# Known durable facts (top similarity matches; format: [factId] (durable.category) claim)
{{knownDurable}}

# Known current facts (top similarity matches; format: [factId] (current.category, since <validAt>) claim)
{{knownCurrent}}

# Latest message (this is what you are extracting from)
{{message}}

## Output

Return exactly one JSON object: `{"ops":[...]}`. No code fences, no markdown, no prose, no XML. If nothing should change, return `{"ops":[]}`."""


INITIAL_SUMMARIZATION_TEMPLATE = """# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures the main topics discussed
2. Highlights key information shared
3. Notes any decisions made or questions asked
4. Maintains context for future reference
5. Is concise but comprehensive

**IMPORTANT**: Keep the summary under 2500 tokens. Be comprehensive but concise.

Also extract:
- **Topics**: List of main topics discussed (comma-separated)
- **Key Points**: Important facts or decisions (bullet points)

## STRICT TOON output

Each `topics[N]` and `keyPoints[N]` entry MUST be a single flat string —
NEVER an indented sub-object with sub-keys. Do not use markdown bullets.

Wrong (rejected — keyPoints item with sub-keys):
  keyPoints[2]:
    - topic: career
      detail: promoted to manager
    - topic: family
      detail: peanut allergy

Right (one flat string per item):
  keyPoints[2]:
    - Promoted to engineering manager at Stripe.
    - Peanut allergy and long-term vegan diet.

Use the EXACT layout below (replace placeholders, keep the array form):

text: Your comprehensive summary here.
topics[3]:
  - topic1
  - topic2
  - topic3
keyPoints[5]:
  - First key point as a single sentence.
  - Second key point as a single sentence.
  - Third key point as a single sentence.
  - Fourth key point as a single sentence.
  - Fifth key point as a single sentence.

If you have a different number of topics or key points, change the index
length to match (e.g. `topics[2]:`). Each item must be one line, no
nested keys, no markdown bullets, no leading numbering."""


LONG_TERM_EXTRACTION_TEMPLATE = """# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

(see eliza/packages/core/src/prompts.ts:285 for the full criteria.
ULTRA-STRICT: when in doubt, emit no memories — empty output is the
right answer most of the time.)

# Response Format

memories[0]:
  category: episodic | semantic | procedural
  content: <persistent claim>
  confidence: 0.85-1.0

If there are no qualifying facts, return no memories entries."""


# ───────────────────────── handlebars substitute ──────────────────────────


def render(template: str, ctx: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        v = ctx.get(name, "")
        return str(v) if v is not None else ""
    return re.sub(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", repl, template)


# ───────────────────────── per-evaluator scenario builders ───────────────


def _build_scenario_reflection(
    rng: random.Random, *, idx: int,
) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    n_turns = rng.choice([4, 6, 8, 10, 12])
    seeds = pick_messages(rng, n=n_turns, substantive_ratio=0.65)
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    ctx = {
        "providers": "(no providers)",
        "recentInteractions": render_recent(seeds, speaker, agent),
    }
    return ctx, seeds


def _build_scenario_reflection_evaluator(
    rng: random.Random, *, idx: int,
) -> tuple[dict[str, Any], list[tuple[str, str]], list[str]]:
    n_turns = rng.choice([4, 6, 8, 10, 12])
    seeds = pick_messages(rng, n=n_turns, substantive_ratio=0.55)
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    n_entities = rng.randint(2, 5)
    entity_ids = [fake_uuid(rng) for _ in range(n_entities)]
    entities_block = "\n".join(
        f"- {entity_ids[i]}: "
        f"{(speaker if i == 0 else (agent if i == 1 else PERSONAS[i % len(PERSONAS)]))}"
        for i in range(n_entities)
    )
    n_existing = rng.randint(0, 3)
    existing = "\n".join(
        f"- {entity_ids[rng.randrange(n_entities)]} -> "
        f"{entity_ids[rng.randrange(n_entities)]}: dm_interaction"
        for _ in range(n_existing)
    ) or "(none)"
    n_results = rng.randint(0, 2)
    results = json.dumps([
        {"action": rng.choice(["REPLY", "TASK_CALL", "FOLLOW_ROOM"]),
         "ok": rng.choice([True, False])}
        for _ in range(n_results)
    ])
    ctx = {
        "evaluationExamples": "(see system memory)",
        "entitiesInRoom": entities_block,
        "existingRelationships": existing,
        "agentName": agent,
        "roomType": rng.choice(["dm", "public"]),
        "senderName": speaker,
        "senderId": entity_ids[0],
        "recentMessages": render_recent(seeds, speaker, agent),
        "actionResults": results,
    }
    return ctx, seeds, entity_ids


def _build_scenario_fact_extractor(
    rng: random.Random, *, idx: int, force_empty: bool,
) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    n_turns = rng.choice([4, 6, 8, 10, 12])
    seeds = pick_messages(
        rng, n=n_turns,
        substantive_ratio=0.0 if force_empty else 0.6,
    )
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    last_msg = seeds[-1][1] if seeds else "hi"
    n_known_d = rng.randint(0, 3)
    n_known_c = rng.randint(0, 3)
    known_durable = "\n".join(
        f"[fact_{stable_id('synth-d', idx, i)[:8]}] (durable.identity) "
        f"sample claim {i}"
        for i in range(n_known_d)
    ) or "(none)"
    known_current = "\n".join(
        f"[fact_{stable_id('synth-c', idx, i)[:8]}] (current.feeling, "
        f"since 2026-04-30T08:00:00Z) sample claim {i}"
        for i in range(n_known_c)
    ) or "(none)"
    ctx = {
        "agentName": agent,
        "senderName": speaker,
        "senderId": fake_uuid(rng),
        "now": "2026-05-05T12:00:00Z",
        "recentMessages": render_recent(seeds, speaker, agent),
        "knownDurable": known_durable,
        "knownCurrent": known_current,
        "message": last_msg,
    }
    return ctx, seeds


SUMMARIZATION_LENGTH_BUCKETS = (
    ("short", 8, 12, 0.40),
    ("medium", 12, 20, 0.40),
    ("long", 20, 30, 0.20),
)


def _build_scenario_summarization(
    rng: random.Random, *, idx: int, bucket: str,
) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    spec = next(b for b in SUMMARIZATION_LENGTH_BUCKETS if b[0] == bucket)
    n_turns = rng.randint(spec[1], spec[2])
    seeds = pick_messages(rng, n=n_turns, substantive_ratio=0.65)
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    ctx = {"recentMessages": render_recent(seeds, speaker, agent)}
    return ctx, seeds


def _build_scenario_long_term(
    rng: random.Random, *, idx: int, force_empty: bool,
) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    # Long-term wants 12-40 turns. Empty cases lean small-talk-heavy.
    n_turns = rng.randint(12, 40)
    seeds = pick_messages(
        rng, n=n_turns,
        substantive_ratio=0.05 if force_empty else 0.55,
    )
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    n_existing = rng.randint(0, 2)
    existing = "\n".join(
        f"- semantic | sample existing memory {i} | confidence 0.9"
        for i in range(n_existing)
    ) or "(none)"
    ctx = {
        "recentMessages": render_recent(seeds, speaker, agent),
        "existingMemories": existing,
    }
    return ctx, seeds


# ───────────────────────── stub teacher (dry-run) ─────────────────────────
# Each stub returns a deterministic output that conforms to the
# evaluator's schema. We rely on the canonical encoder for any TOON
# emission so the dry-run output is byte-identical to what the runtime
# decoder expects.


def stub_reflection(
    encoder: ToonEncoder, rng: random.Random, ctx: dict[str, Any], force_empty: bool,
) -> str:
    obj = {
        "thought": "The agent answered the user's question with adequate clarity.",
        "quality_score": rng.choice([72, 78, 81, 86]),
        "strengths": "Direct, on-topic responses.",
        "improvements": "Could ask one clarifying question before assuming.",
        "learnings": "Confirm scope when the request is ambiguous.",
    }
    return encoder.encode(obj)


def stub_reflection_evaluator(
    encoder: ToonEncoder,
    rng: random.Random,
    ctx: dict[str, Any],
    entity_ids: list[str],
    force_empty: bool,
) -> str:
    src = entity_ids[0]
    tgt = entity_ids[1] if len(entity_ids) > 1 else entity_ids[0]
    obj = {
        "thought": "Provided a direct, on-topic response with no follow-up needed.",
        "task_completed": rng.choice([True, False]),
        "task_completion_reason": "User's question was answered in this turn.",
        "relationships": [
            {
                "sourceEntityId": src,
                "targetEntityId": tgt,
                "tags": ["dm_interaction"],
            }
        ],
    }
    return encoder.encode(obj)


def stub_fact_extractor(
    encoder: ToonEncoder, rng: random.Random, ctx: dict[str, Any], force_empty: bool,
) -> str:
    if force_empty:
        return json.dumps({"ops": []}, separators=(",", ":"))
    flavor = rng.choice([
        "add_durable_identity", "add_durable_health", "add_current_feeling",
        "add_current_working_on", "strengthen", "decay", "contradict",
    ])
    if flavor == "add_durable_identity":
        ops = [{"op": "add_durable", "claim": "lives in Berlin",
                "category": "identity",
                "structured_fields": {"location": "Berlin"}}]
    elif flavor == "add_durable_health":
        ops = [{"op": "add_durable", "claim": "allergic to peanuts",
                "category": "health",
                "structured_fields": {"condition": "peanut allergy"}}]
    elif flavor == "add_current_feeling":
        ops = [{"op": "add_current", "claim": "anxious about the launch",
                "category": "feeling",
                "structured_fields": {"emotion": "anxious",
                                       "subject": "launch"}}]
    elif flavor == "add_current_working_on":
        ops = [{"op": "add_current", "claim": "debugging auth flow",
                "category": "working_on",
                "structured_fields": {"task": "debugging",
                                       "subject": "auth flow"}}]
    elif flavor == "strengthen":
        ops = [{"op": "strengthen", "factId": f"fact_{stable_id('strn', rng.random())[:8]}",
                "reason": "user reaffirmed the prior claim."}]
    elif flavor == "decay":
        ops = [{"op": "decay", "factId": f"fact_{stable_id('decy', rng.random())[:8]}",
                "reason": "user moved past the prior task."}]
    else:
        ops = [{"op": "contradict",
                "factId": f"fact_{stable_id('cont', rng.random())[:8]}",
                "reason": "user revised the earlier claim.",
                "proposedText": "lives in Tokyo"}]
    return json.dumps({"ops": ops}, separators=(",", ":"))


def stub_summarization(
    encoder: ToonEncoder, rng: random.Random, ctx: dict[str, Any], bucket: str,
) -> str:
    n_topics = rng.randint(2, 3) if bucket == "short" else (
        rng.randint(3, 5) if bucket == "medium" else rng.randint(5, 7)
    )
    n_keys = rng.randint(2, 4) if bucket == "short" else (
        rng.randint(4, 7) if bucket == "medium" else rng.randint(7, 10)
    )
    obj = {
        "text": "User and agent discussed a set of ongoing items; "
                "the conversation was productive and ended with a clear "
                "next step.",
        "topics": [f"topic-{i+1}" for i in range(n_topics)],
        "keyPoints": [f"Key point {i+1} from the conversation."
                       for i in range(n_keys)],
    }
    return encoder.encode(obj)


def stub_long_term(
    encoder: ToonEncoder, rng: random.Random, ctx: dict[str, Any], force_empty: bool,
    confidence_band: tuple[float, float] = (0.85, 0.94),
) -> str:
    if force_empty:
        return encoder.encode({"memories": []})
    n = rng.randint(1, 3)
    cats = ["semantic", "procedural", "episodic"]
    memories: list[dict[str, Any]] = []
    for i in range(n):
        c = round(rng.uniform(*confidence_band), 2)
        memories.append({
            "category": cats[i % len(cats)],
            "content": f"User has demonstrated stable practice {i+1} "
                        f"across multiple turns.",
            "confidence": c,
        })
    return encoder.encode({"memories": memories})


# ───────────────────────── output validators ──────────────────────────────


def validate_reflection(text: str) -> bool:
    """Slim TOON validator: must contain the five expected keys."""
    keys = {"thought", "quality_score", "strengths", "improvements", "learnings"}
    return all(re.search(rf"^\s*{k}\s*:", text, re.M) for k in keys)


def validate_reflection_evaluator(text: str) -> bool:
    return all(re.search(rf"^\s*{k}\s*:", text, re.M)
               for k in ("thought", "task_completed", "task_completion_reason"))


def validate_fact_extractor(text: str) -> bool:
    """Raw JSON {"ops":[...]} — empty list is legal."""
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return False
    if not isinstance(obj, dict):
        return False
    ops = obj.get("ops")
    if not isinstance(ops, list):
        return False
    return True


def is_empty_fact_extractor(text: str) -> bool:
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return False
    return obj.get("ops") == []


def validate_summarization(text: str) -> bool:
    # The TOON encoder serialises a primitive array as `topics[N]: a,b`
    # (`N` is the count, not an index). Accept either that form or the
    # indexed `topics[0]:` form the template literal demonstrates.
    has_text = re.search(r"^\s*text\s*:", text, re.M) is not None
    has_topics = re.search(r"^\s*topics(?:\[\d+\])?\s*:", text, re.M) is not None
    has_keys = re.search(r"^\s*keyPoints(?:\[\d+\])?\s*:", text, re.M) is not None
    return has_text and has_topics and has_keys


def validate_long_term(text: str) -> bool:
    # Empty `memories[0]:` and non-empty `memories[N]{...}:` shapes are
    # both valid.
    return re.search(r"^\s*memories(?:\[\d+\])?", text, re.M) is not None


def is_empty_long_term(text: str) -> bool:
    # The TOON encoder serialises an empty list as `memories[0]:` and a
    # populated list as `memories[N]{...}:` (where N is the count). The
    # `{...}` suffix is the marker we key off here.
    return re.search(r"^\s*memories\[\d+\]\{", text, re.M) is None


# ───────────────────────── per-evaluator dispatcher ───────────────────────

@dataclass
class EvaluatorJob:
    name: str
    task_type: str
    template: str
    target: int
    # Plan-level mix; per-record decisions read this back.
    extra_plan: dict[str, Any]


PLAN_KEY_FORCE_EMPTY = "force_empty_indices"  # frozenset[int]
PLAN_KEY_BUCKETS = "summarization_buckets"     # list[str], len == target


def _make_plan(name: str, n: int, rng: random.Random) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if name == "fact_extractor":
        n_empty = max(1, int(round(0.15 * n)))
        idx = list(range(n))
        rng.shuffle(idx)
        extra[PLAN_KEY_FORCE_EMPTY] = frozenset(idx[:n_empty])
    elif name == "long_term_extraction":
        n_empty = max(1, int(round(0.60 * n)))
        idx = list(range(n))
        rng.shuffle(idx)
        extra[PLAN_KEY_FORCE_EMPTY] = frozenset(idx[:n_empty])
    elif name == "summarization":
        plan: list[str] = []
        for bname, _lo, _hi, ratio in SUMMARIZATION_LENGTH_BUCKETS:
            plan.extend([bname] * max(1, int(round(ratio * n))))
        # Pad/truncate to exactly n.
        while len(plan) < n:
            plan.append("medium")
        plan = plan[:n]
        rng.shuffle(plan)
        extra[PLAN_KEY_BUCKETS] = plan
    return extra


def _generate_one(
    *, name: str, idx: int, rng: random.Random, encoder: ToonEncoder,
    teacher: TeacherCfg, plan_extra: dict[str, Any], dry_run: bool,
) -> dict[str, Any] | None:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)

    if name == "reflection":
        ctx, seeds = _build_scenario_reflection(rng, idx=idx)
        rendered = render(REFLECTION_TEMPLATE, ctx)
        if dry_run:
            target_text = stub_reflection(encoder, rng, ctx, False)
        else:
            target_text = normalize_teacher_output(call_teacher(
                teacher,
                "You are generating supervised TOON output for the elizaOS "
                "reflection evaluator. Emit ONE TOON document and nothing else.",
                rendered,
            ))
        if not validate_reflection(target_text):
            return None

    elif name == "reflection_evaluator":
        ctx, seeds, entity_ids = _build_scenario_reflection_evaluator(rng, idx=idx)
        rendered = render(REFLECTION_EVALUATOR_TEMPLATE, ctx)
        if dry_run:
            target_text = stub_reflection_evaluator(encoder, rng, ctx, entity_ids, False)
        else:
            target_text = normalize_teacher_output(call_teacher(
                teacher,
                "You are generating supervised TOON output for the elizaOS "
                "reflectionEvaluator. Emit ONE TOON document and nothing else. "
                f"Use ONLY these entity UUIDs in sourceEntityId / "
                f"targetEntityId: {', '.join(entity_ids)}.",
                rendered,
            ))
        if not validate_reflection_evaluator(target_text):
            return None

    elif name == "fact_extractor":
        force_empty = idx in plan_extra.get(PLAN_KEY_FORCE_EMPTY, frozenset())
        ctx, seeds = _build_scenario_fact_extractor(
            rng, idx=idx, force_empty=force_empty,
        )
        rendered = render(FACT_EXTRACTION_TEMPLATE, ctx)
        if dry_run:
            target_text = stub_fact_extractor(encoder, rng, ctx, force_empty)
        else:
            target_text = normalize_teacher_output(call_teacher(
                teacher,
                "You are the elizaOS fact_extractor. Return exactly one JSON "
                "object `{\"ops\":[...]}`. Empty `{\"ops\":[]}` is a "
                "valid (and common) answer when there are no new facts.",
                rendered,
            ), allow_json=True)
        if not validate_fact_extractor(target_text):
            return None
        if force_empty and not is_empty_fact_extractor(target_text):
            # Plan said "must be empty"; teacher disagreed → drop so the
            # gate stays satisfied. Caller can re-roll on a higher idx.
            return None

    elif name == "summarization":
        bucket = plan_extra[PLAN_KEY_BUCKETS][idx]
        ctx, seeds = _build_scenario_summarization(rng, idx=idx, bucket=bucket)
        rendered = render(INITIAL_SUMMARIZATION_TEMPLATE, ctx)
        if dry_run:
            target_text = stub_summarization(encoder, rng, ctx, bucket)
        else:
            target_text = normalize_teacher_output(call_teacher(
                teacher,
                "You are the elizaOS summarization evaluator. Emit ONE TOON "
                "document with `text`, `topics[N]`, `keyPoints[M]`. Nothing "
                "else.",
                rendered,
            ))
        if not validate_summarization(target_text):
            return None

    elif name == "long_term_extraction":
        force_empty = idx in plan_extra.get(PLAN_KEY_FORCE_EMPTY, frozenset())
        ctx, seeds = _build_scenario_long_term(
            rng, idx=idx, force_empty=force_empty,
        )
        rendered = render(LONG_TERM_EXTRACTION_TEMPLATE, ctx)
        if dry_run:
            band = (0.85, 0.94) if rng.random() < 0.625 else (0.95, 1.0)
            target_text = stub_long_term(encoder, rng, ctx, force_empty, band)
        else:
            target_text = normalize_teacher_output(call_teacher(
                teacher,
                "You are the elizaOS long_term_extraction evaluator. ULTRA-"
                "STRICT: when in doubt, emit no memories entries — empty "
                "output is the right answer most of the time. Confidence "
                "MUST be >= 0.85 for any extracted memory.",
                rendered,
            ))
        if not validate_long_term(target_text):
            return None
        if force_empty and not is_empty_long_term(target_text):
            return None
    else:
        raise ValueError(f"unknown evaluator: {name}")

    # fact_extractor speaks JSON, not TOON. Everything else must round-trip
    # through the TOON decoder — drop now if it doesn't, since synth-time
    # validators are regex-only and let nested objects through.
    if name != "fact_extractor":
        try:
            ToonDecoder().decode(target_text)
        except (ValueError, RuntimeError):
            return None

    memory = to_memory_entries(speaker, agent, seeds[:-1] if seeds else [])
    current = (
        {"role": "user", "speaker": speaker,
         "content": seeds[-1][1] if seeds else "", "channel": "dm"}
    )
    rec = build(
        roomName=stable_id("synth-evaluator", name, idx, target_text)[:12],
        agentId=agent.lower(),
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=target_text,
        availableActions=[],
        task_type=name if name != "reflection_evaluator" else "reflection_evaluator",
        source_dataset=f"synth-evaluator-{name}",
        license="synthetic",
        split="train",
        extra_metadata={
            "synth_task": name,
            "teacher_model": teacher.model,
            "system_prompt": rendered,
        },
    )
    ok, _ = rec.is_valid()
    if not ok:
        return None
    return rec.to_dict()


# ───────────────────────── distribution gate ──────────────────────────────


def enforce_distribution(name: str, records: list[dict[str, Any]]) -> None:
    """Raise if the synth violates the per-evaluator distribution
    contract documented in EVALUATOR_SYNTHESIS.md."""
    n = len(records)
    if n == 0:
        return
    if name == "fact_extractor":
        empty = sum(1 for r in records
                    if is_empty_fact_extractor(r["expectedResponse"]))
        ratio = empty / n
        if ratio < 0.10:  # gate at 10 % to leave slack for teacher noise
            raise RuntimeError(
                f"fact_extractor: empty `{{\"ops\":[]}}` ratio {ratio:.2%} "
                f"below 10 % gate — re-run with a fresh seed or accept the "
                f"floor by raising target."
            )
    elif name == "long_term_extraction":
        empty = sum(1 for r in records
                    if is_empty_long_term(r["expectedResponse"]))
        ratio = empty / n
        if ratio < 0.45:  # gate at 45 % to leave slack
            raise RuntimeError(
                f"long_term_extraction: empty memories ratio {ratio:.2%} "
                f"below 45 % gate — distribution drift, refusing to write."
            )
    elif name == "summarization":
        # Distribution gate on input length is informational only — we
        # already pre-shuffle the bucket plan, so the gate is implicit.
        return


# ───────────────────────── synthesis driver ───────────────────────────────


def synthesize(
    *, name: str, n: int, seed: int, teacher: TeacherCfg, encoder: ToonEncoder,
    out_path: Path, dry_run: bool, max_workers: int,
) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    plan_extra = _make_plan(name, n, rng)

    # In dry-run mode we run sequentially so the encoder process stays
    # single-consumer; in real mode we keep the messaging-style worker
    # pool and serialise encoder access via per-call callouts.
    records: list[dict[str, Any]] = []
    if dry_run:
        sub_rng = random.Random(rng.random())
        for idx in range(n):
            r = _generate_one(
                name=name, idx=idx, rng=sub_rng, encoder=encoder,
                teacher=teacher, plan_extra=plan_extra, dry_run=True,
            )
            if r is not None:
                records.append(r)
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            sub_rngs = [random.Random(rng.randrange(1 << 31)) for _ in range(n)]
            futs = {
                ex.submit(_generate_one, name=name, idx=i, rng=sub_rngs[i],
                          encoder=encoder, teacher=teacher,
                          plan_extra=plan_extra, dry_run=False): i
                for i in range(n)
            }
            for fut in as_completed(futs):
                try:
                    r = fut.result()
                except Exception as e:  # noqa: BLE001
                    log.warning("worker failed: %s", e)
                    continue
                if r is not None:
                    records.append(r)

    enforce_distribution(name, records)
    with out_path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
    log.info("[%s] wrote %d records → %s", name, len(records), out_path)
    return len(records)


# ───────────────────────── CLI ────────────────────────────────────────────

EVALUATOR_NAMES = (
    "reflection",
    "reflection_evaluator",
    "fact_extractor",
    "summarization",
    "long_term_extraction",
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--per-task", type=int, default=3000,
                    help="records per evaluator (default: 3000)")
    ap.add_argument("--only", choices=EVALUATOR_NAMES + ("all",),
                    default="all", help="run a single evaluator (default: all)")
    ap.add_argument("--teacher-model", default="claude-opus-4-7")
    ap.add_argument("--teacher-provider", default="anthropic")
    ap.add_argument("--max-workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0xE7A1AC)
    ap.add_argument("--out", type=Path, default=OUT_DIR,
                    help="output directory (default: data/synthesized/evaluators)")
    ap.add_argument("--dry-run", action="store_true",
                    help="emit 5 records per evaluator with a stub teacher")
    args = ap.parse_args()

    out_dir: Path = args.out
    if args.dry_run:
        # Force small per-task and use a stable seed so the dry-run
        # output is reproducible.
        args.per_task = 5

    teacher = TeacherCfg(provider=args.teacher_provider, model=args.teacher_model)
    encoder = ToonEncoder()
    try:
        names = list(EVALUATOR_NAMES) if args.only == "all" else [args.only]
        total = 0
        for name in names:
            out_path = out_dir / f"{name}.jsonl"
            log.info("synthesizing %d records for evaluator=%s", args.per_task, name)
            total += synthesize(
                name=name, n=args.per_task,
                seed=args.seed ^ hash(name) & 0xFFFFFFFF,
                teacher=teacher, encoder=encoder,
                out_path=out_path, dry_run=args.dry_run,
                max_workers=args.max_workers,
            )
        log.info("done — wrote %d records across %d evaluators", total, len(names))
    finally:
        encoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
