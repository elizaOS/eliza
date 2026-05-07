"""Legacy TOON synthesizer for Phase-3 action-handler records.

This script is not a native v5 JSON export path yet. It remains quarantined
for compatibility corpus rebuilds until the teacher prompts and validators are
rewritten around JSON targets.

The runtime tags the per-action LLM call with ``purpose: "action"`` (see
docs/dataset/RUNTIME_PHASES.md). Several action templates have NO
coverage in the published corpus — this synthesizer closes that gap.

Targets (template literal locations under
``eliza/packages/core/src/prompts.ts``):

    REPLY                       replyTemplate                     :915
    REMOVE_CONTACT              removeContactTemplate             :892
    EXTRACT_OPTION              optionExtractionTemplate          :598
    EXTRACT_SECRET_OPERATION    extractSecretOperationTemplate    :152
    EXTRACT_SECRET_REQUEST      extractSecretRequestTemplate      :175
    POST_CREATION               postCreationTemplate              :661
    POST_ACTION_DECISION        postActionDecisionTemplate        :621

Skipped: IMAGE_DESCRIPTION + IMAGE_GENERATION (need vision data),
AUTONOMY_* (deferred per RUNTIME_PHASES + EVALUATOR_SYNTHESIS specs).

Outputs:
    data/synthesized/phase3/<action>.jsonl

Each record is a canonical ``ElizaRecord`` with ``task_type`` set to the
runtime task slug listed in ``lib.runtime_phases.PHASE_3_ACTION``:

    reply, remove_contact, extract_option, extract_secret_operation,
    extract_secret_request, post_creation, post_action_decision

Usage::

    export ANTHROPIC_API_KEY=...
    .venv/bin/python scripts/synthesize_phase3_actions.py
    .venv/bin/python scripts/synthesize_phase3_actions.py --only reply
    .venv/bin/python scripts/synthesize_phase3_actions.py --dry-run \
        --out /tmp/p3_dry/

The ``--dry-run`` mode replaces the teacher with a deterministic stub
that returns canned, schema-valid output for each task — use it to
verify the wiring without an API key.
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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import build, stable_id  # noqa: E402
from lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

OUT_DIR = ROOT / "data" / "synthesized" / "phase3"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-phase3")


# ───────────────────────── teacher client ──────────────────────────────────

@dataclass
class TeacherCfg:
    provider: str
    model: str
    max_tokens: int = 4096
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
    """OpenAI-compatible /v1/chat/completions caller. See evaluator
    synthesizer for the same code; kept duplicated to keep each
    synthesizer file standalone."""
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
            "User-Agent": "milady-synth/1.0 (+https://github.com/elizaOS/eliza)",
        },
        method="POST",
    )
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
    # gpt-oss-120b loves to prefix the output with a bare `TOON`/`JSON`
    # header line. Drop those (they're never valid keys).
    lines = s.splitlines()
    while lines and lines[0].strip().lower() in (
        "toon", "toon:", "json", "json:", "output", "output:",
    ):
        lines.pop(0)
    return "\n".join(lines).strip()


def _json_to_toon(obj) -> str | None:
    """Encode a Python primitive/dict/list as TOON. Returns None if the
    shape can't be represented (e.g. nested arrays of nested objects of
    arrays — TOON has no representation for that)."""
    try:
        from lib.toon import ToonEncoder as _Enc
        return _Enc().encode(obj)
    except Exception:  # noqa: BLE001
        return None


def _maybe_json_payload(s: str) -> str:
    """If `s` looks like a JSON object (model returned JSON instead of
    TOON), parse it and re-encode as TOON. Otherwise return `s` unchanged.

    The teacher sometimes emits `{ "key": "v", ... }` even when the prompt
    asks for TOON. We recover by transcoding."""
    t = s.strip()
    if not (t.startswith("{") and t.endswith("}")):
        return s
    try:
        obj = json.loads(t)
    except json.JSONDecodeError:
        return s
    encoded = _json_to_toon(obj)
    return encoded if encoded is not None else s


_INDEXED_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]\s*:\s*(.+)$")


def repair_toon_bullets(s: str) -> str:
    """Two repair passes for common gpt-oss-120b TOON deviations.

    Pass 1: collapse `key[0]: a / key[1]: b / ...` into `key[N]:\n  - a\n  - b`.
    Pass 2: convert markdown bullets (`key:\n- a\n- b`) into TOON array form.
    Idempotent on already-valid TOON. Mirrors transform_repair_toon_bullets.py."""
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


def normalize_teacher_output(s: str) -> str:
    """Strip fences, transcode JSON→TOON if needed, apply repair passes,
    then round-trip through TOON decoder/encoder to canonicalize.
    One-stop normaliser for every teacher-call site so a single fix
    lands everywhere."""
    cleaned = repair_toon_bullets(_maybe_json_payload(strip_fences(s)))
    # Round-trip: if it decodes, re-encode canonically. This collapses
    # quoted keys, mixed-style lines, and other parser-tolerated noise
    # into the form our regex validators expect.
    try:
        from lib.toon import ToonDecoder as _Dec, ToonEncoder as _Enc
        decoded = _Dec().decode(cleaned)
        if isinstance(decoded, (dict, list)):
            return _Enc().encode(decoded)
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

X_USER_NAMES = [
    "iris_dev", "kai_io", "ava_ml", "nova_ai", "echo_loop", "sage_codes",
    "atlas_sys", "lyra_intl", "pico_bytes", "lumi_lab",
]


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
    lines = []
    for role, text in snippet:
        name = speaker if role == "user" else agent
        lines.append(f"{name}: {text}")
    return "\n".join(lines)


# ───────────────────────── per-task scenario pools ────────────────────────

REPLY_SEEDS: list[tuple[list[tuple[str, str]], str, str]] = [
    # (memory_snippet, current_user_msg, canned_reply_text)
    (
        [("user", "morning"), ("agent", "morning! how can I help?")],
        "How do I export a Pandas DataFrame to Parquet?",
        "Use `df.to_parquet('out.parquet')`. Pandas picks pyarrow by "
        "default if it's installed, otherwise pass `engine='fastparquet'`.",
    ),
    (
        [],
        "What's the weather like in Tokyo today?",
        "I can't pull live weather right now, but I can help you plan "
        "around a forecast if you tell me what window you care about.",
    ),
    (
        [("user", "I'm prepping a talk for next week"),
         ("agent", "What's the topic?")],
        "Distributed tracing for small teams.",
        "Nice. The 'small teams' angle is the hook — most tracing "
        "advice assumes large infra. Want me to draft an outline?",
    ),
    (
        [],
        "thanks for the help yesterday",
        "Anytime — happy it landed.",
    ),
    (
        [("user", "thinking about migrating to Postgres")],
        "Worth it for a 50GB table?",
        "At 50GB the migration is straightforward — pg_dump / "
        "logical-replication both work. I'd more weigh ops familiarity "
        "than table size.",
    ),
]

REMOVE_CONTACT_SEEDS: list[tuple[list[tuple[str, str]], str, str, str]] = [
    # (memory, current_msg, contact_name, confirmed)
    (
        [],
        "Please remove Jane Doe from my contacts.",
        "Jane Doe", "yes",
    ),
    (
        [("user", "I want to clean up my contacts list")],
        "Drop Marcus Chen.",
        "Marcus Chen", "no",
    ),
    (
        [],
        "Yes, go ahead and delete the entry for my old colleague Priya.",
        "Priya", "yes",
    ),
    (
        [("user", "Is there a Helen in my contacts?"),
         ("agent", "Yes — Helen Tanaka.")],
        "Maybe remove her? Not sure yet.",
        "Helen Tanaka", "no",
    ),
    (
        [],
        "delete contact: Rohan Patel — confirmed",
        "Rohan Patel", "yes",
    ),
]

EXTRACT_OPTION_SEEDS: list[tuple[list[tuple[str, str]], str, str, str]] = [
    # (memory, current_msg, taskId, selectedOption)
    (
        [("agent", "Pick a deploy target: A) staging  B) prod  C) ABORT")],
        "Let's go with staging.",
        "deploy-task-91ab", "staging",
    ),
    (
        [("agent", "What format do you want? csv / json / parquet")],
        "json please",
        "export-task-77cd", "json",
    ),
    (
        [("agent", "Confirm action — yes / no / abort")],
        "abort",
        "approve-task-22ee", "abort",
    ),
    (
        [("agent", "Which channel: discord / slack / email")],
        "i guess email",
        "notify-task-31ff", "email",
    ),
    (
        [("agent", "Pick a region: us-east / us-west / eu-central")],
        "us-west works",
        "region-task-58aa", "us-west",
    ),
]

EXTRACT_SECRET_OPERATION_SEEDS: list[tuple[list[tuple[str, str]], str, str, str, str]] = [
    # (memory, current_msg, operation, key, value)
    ([], "What is my OpenAI key?",
     "get", "OPENAI_API_KEY", ""),
    ([], "Set my Discord token to abc123def",
     "set", "DISCORD_BOT_TOKEN", "abc123def"),
    ([], "Show me my secrets",
     "list", "", ""),
    ([], "Delete my old API key for Twitter",
     "delete", "TWITTER_API_KEY", ""),
    ([], "Do I have an Anthropic API key set?",
     "check", "ANTHROPIC_API_KEY", ""),
]

EXTRACT_SECRET_REQUEST_SEEDS: list[tuple[list[tuple[str, str]], str, str, str]] = [
    # (memory, current_msg, key, reason)
    (
        [("agent", "I need an API key to call OpenAI for you.")],
        "I'll grab it from 1password — gimme a sec.",
        "OPENAI_API_KEY", "Required to call the OpenAI inference API.",
    ),
    (
        [("agent", "I can't post to Twitter without TWITTER_API_KEY.")],
        "ok where do I add it",
        "TWITTER_API_KEY", "Required to authenticate the Twitter posting flow.",
    ),
    (
        [("agent", "Missing DISCORD_BOT_TOKEN.")],
        "fine I'll set it",
        "DISCORD_BOT_TOKEN", "Required to log in as the Discord bot.",
    ),
    (
        [("agent", "Need GITHUB_TOKEN to run this query.")],
        "where do I generate one",
        "GITHUB_TOKEN", "Required to call the GitHub REST API.",
    ),
    (
        [("agent", "I don't have a SENDGRID_API_KEY configured.")],
        "I'll add one",
        "SENDGRID_API_KEY", "Required to send transactional email via SendGrid.",
    ),
]

POST_CREATION_SEEDS: list[tuple[str, str, str, str]] = [
    # (topic, adjective, post_text, image_prompt)
    (
        "AI agents replacing internal tools",
        "thought-provoking",
        "Most internal tools are 80% form-over-function. The future "
        "isn't fancier dashboards — it's an agent that just does the "
        "thing.",
        "A minimalist screen showing a single chat bubble replacing a complex dashboard",
    ),
    (
        "long-running side projects",
        "honest",
        "The side project I'm proudest of took six years to ship. "
        "Most of those years were silence. Doesn't make the silence "
        "wasted.",
        "A workshop with a single warm lamp and a long-running clock on the wall",
    ),
    (
        "remote work fatigue",
        "candid",
        "Async is a superpower until it isn't. Sometimes you just need "
        "to be in a room together for 90 minutes.",
        "Two laptops on a kitchen table at dusk with empty coffee cups",
    ),
    (
        "the joy of learning a new programming language",
        "enthusiastic",
        "Learning a new language always exposes a habit you didn't "
        "know was a habit. That's the whole point.",
        "A scattered desk with reference books and a glowing terminal",
    ),
    (
        "small startups vs big tech",
        "playful",
        "Big-tech ships features. Small startups ship products. Both "
        "matter, but only one is fun on a Friday night.",
        "Two side-by-side offices: one fluorescent and tidy, one warm and messy",
    ),
]

POST_ACTION_DECISION_SEEDS: list[tuple[list[tuple[str, str]], str, list[str]]] = [
    # (memory, action_results, expected_actions)
    (
        [("user", "what's the staging deploy status"),
         ("agent", "checking")],
        "DEPLOY_STATUS returned: state=succeeded build=42 elapsed=4m12s",
        ["REPLY"],
    ),
    (
        [("user", "list issues assigned to me"),
         ("agent", "let me look")],
        "GET_ISSUES returned: 0 issues",
        ["REPLY"],
    ),
    (
        [("user", "thanks!"), ("agent", "anytime")],
        "(no recent action results)",
        ["STOP"],
    ),
    (
        [("user", "ignore the previous"), ("agent", "got it")],
        "(no recent action results)",
        ["IGNORE"],
    ),
    (
        [("user", "are there any open PRs"), ("agent", "checking")],
        "LIST_PRS returned: 3 open PRs",
        ["REPLY"],
    ),
]


# ───────────────────────── stub teachers (dry-run) ────────────────────────


def stub_reply(encoder: ToonEncoder, rng: random.Random, idx: int) -> str:
    seeds_len = len(REPLY_SEEDS)
    _, _, text = REPLY_SEEDS[idx % seeds_len]
    return encoder.encode({
        "thought": "User asked a direct question; respond concisely with a "
                    "useful answer.",
        "text": text,
    })


def stub_remove_contact(encoder: ToonEncoder, rng: random.Random, idx: int) -> str:
    seeds_len = len(REMOVE_CONTACT_SEEDS)
    _, _, name, confirmed = REMOVE_CONTACT_SEEDS[idx % seeds_len]
    return encoder.encode({"contactName": name, "confirmed": confirmed})


def stub_extract_option(encoder: ToonEncoder, rng: random.Random, idx: int) -> str:
    seeds_len = len(EXTRACT_OPTION_SEEDS)
    _, _, task_id, opt = EXTRACT_OPTION_SEEDS[idx % seeds_len]
    return encoder.encode({"taskId": task_id, "selectedOption": opt})


def stub_extract_secret_operation(
    encoder: ToonEncoder, rng: random.Random, idx: int,
) -> str:
    seeds_len = len(EXTRACT_SECRET_OPERATION_SEEDS)
    _, _, op, key, val = EXTRACT_SECRET_OPERATION_SEEDS[idx % seeds_len]
    obj: dict[str, Any] = {"operation": op}
    if key:
        obj["key"] = key
    if val:
        obj["value"] = val
    obj["level"] = "user"
    return encoder.encode(obj)


def stub_extract_secret_request(
    encoder: ToonEncoder, rng: random.Random, idx: int,
) -> str:
    seeds_len = len(EXTRACT_SECRET_REQUEST_SEEDS)
    _, _, key, reason = EXTRACT_SECRET_REQUEST_SEEDS[idx % seeds_len]
    return encoder.encode({"key": key, "reason": reason})


def stub_post_creation(encoder: ToonEncoder, rng: random.Random, idx: int) -> str:
    seeds_len = len(POST_CREATION_SEEDS)
    topic, adj, post, img = POST_CREATION_SEEDS[idx % seeds_len]
    return encoder.encode({
        "thought": f"Crafting a {adj} post on the topic of {topic}, "
                    f"keeping it under 280 chars.",
        "post": post,
        "imagePrompt": img,
    })


def stub_post_action_decision(
    encoder: ToonEncoder, rng: random.Random, idx: int,
) -> str:
    seeds_len = len(POST_ACTION_DECISION_SEEDS)
    _, _, actions = POST_ACTION_DECISION_SEEDS[idx % seeds_len]
    return encoder.encode({
        "thought": "Reviewed the action results; deciding next step.",
        "actions": [{"name": a} for a in actions],
        "providers": [],
        "text": "" if actions[0] in ("STOP", "IGNORE") else
                 "Here's what I found.",
        "simple": False,
    })


# ───────────────────────── per-task validators ────────────────────────────


def validate_toon_keys(text: str, *required: str) -> bool:
    return all(re.search(rf"^\s*{k}\s*:", text, re.M) for k in required)


def validate_reply(text: str) -> bool:
    # The runtime accepts the slim `{thought, text}` shape OR the full
    # planner envelope. Either is fine for our synth purposes.
    return validate_toon_keys(text, "thought", "text") or \
            validate_toon_keys(text, "text")


def validate_remove_contact(text: str) -> bool:
    return validate_toon_keys(text, "contactName", "confirmed")


def validate_extract_option(text: str) -> bool:
    return validate_toon_keys(text, "taskId", "selectedOption")


def validate_extract_secret_operation(text: str) -> bool:
    return validate_toon_keys(text, "operation")


def validate_extract_secret_request(text: str) -> bool:
    return validate_toon_keys(text, "key")


def validate_post_creation(text: str) -> bool:
    return validate_toon_keys(text, "thought", "post")


def validate_post_action_decision(text: str) -> bool:
    return validate_toon_keys(text, "thought") and (
        "actions[" in text or "actions:" in text
        or validate_toon_keys(text, "text")
    )


# ───────────────────────── per-task scenario builders ─────────────────────
# Each builder returns (memoryEntries, currentMessage, system_prompt).
# The current_msg is the user turn the action handler is reacting to.


def _build_reply(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(REPLY_SEEDS)
    memory, msg, _ = REPLY_SEEDS[idx % seeds_len]
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory, "current": msg,
        "rendered": (
            f"# Task: Generate dialog for the character {agent}.\n\n"
            f"(no providers)\n\n"
            f"# Recent Messages:\n{render_recent(memory, speaker, agent)}\n"
            f"{speaker}: {msg}\n\n"
            f"# Instructions: Write the next message for {agent}.\n"
            f"\"thought\" is a short plan; \"text\" is the next message.\n"
            f"Respond using TOON.\n"
        ),
    }


def _build_remove_contact(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(REMOVE_CONTACT_SEEDS)
    memory, msg, _, _ = REMOVE_CONTACT_SEEDS[idx % seeds_len]
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory, "current": msg,
        "rendered": (
            "task: Extract the contact removal request.\n\n"
            "context:\n(no providers)\n\n"
            f"current_message:\n{msg}\n\n"
            "instructions[4]:\n"
            "- identify the contact name to remove\n"
            "- set confirmed to yes only when the user explicitly confirms\n"
            "- return only the requested contact\n\n"
            "output:\nTOON only.\n"
            "Example:\ncontactName: Jane Doe\nconfirmed: yes"
        ),
    }


def _build_extract_option(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(EXTRACT_OPTION_SEEDS)
    memory, msg, task_id, _ = EXTRACT_OPTION_SEEDS[idx % seeds_len]
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory, "current": msg,
        "rendered": (
            "# Task: Extract selected task and option from user message\n\n"
            f"# Available Tasks:\n- {task_id}: see options offered above\n\n"
            "# Recent Messages:\n"
            f"{render_recent(memory, speaker, agent)}\n"
            f"{speaker}: {msg}\n\n"
            "Return in TOON format:\n"
            "taskId: string_or_null\nselectedOption: OPTION_NAME_or_null"
        ),
    }


def _build_extract_secret_operation(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(EXTRACT_SECRET_OPERATION_SEEDS)
    memory, msg, _, _, _ = EXTRACT_SECRET_OPERATION_SEEDS[idx % seeds_len]
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory, "current": msg,
        "rendered": (
            "You are helping manage secrets for an AI agent.\n"
            "Determine what operation the user wants to perform: "
            "get / set / delete / list / check.\n\n"
            f"{render_recent(memory, speaker, agent)}\n"
            f"{speaker}: {msg}\n\n"
            "Extract the operation, key (if applicable), value (if applicable), "
            "and level."
        ),
    }


def _build_extract_secret_request(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(EXTRACT_SECRET_REQUEST_SEEDS)
    memory, msg, _, _ = EXTRACT_SECRET_REQUEST_SEEDS[idx % seeds_len]
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory, "current": msg,
        "rendered": (
            "You are helping an AI agent request a missing secret.\n\n"
            f"Recent Messages:\n{render_recent(memory, speaker, agent)}\n"
            f"{speaker}: {msg}\n\n"
            "Output: key (e.g. OPENAI_API_KEY) + reason."
        ),
    }


def _build_post_creation(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    x_user = rng.choice(X_USER_NAMES)
    seeds_len = len(POST_CREATION_SEEDS)
    topic, adj, _, _ = POST_CREATION_SEEDS[idx % seeds_len]
    msg = f"please draft a post about {topic}"
    return {
        "speaker": speaker, "agent": agent,
        "memory": [], "current": msg,
        "rendered": (
            f"# Task: Create a post in the voice and style of {agent} "
            f"@{x_user}.\n\n"
            "(no providers)\n\n"
            f"Write a post that is {adj} about {topic} (without "
            f"mentioning {topic} directly), from the perspective of "
            f"{agent}. 1-3 sentences, < 280 chars, no emojis.\n\n"
            "Format as TOON:\nthought: ...\npost: ...\nimagePrompt: ..."
        ),
    }


def _build_post_action_decision(rng: random.Random, idx: int) -> dict[str, Any]:
    speaker = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)
    seeds_len = len(POST_ACTION_DECISION_SEEDS)
    memory, results, _ = POST_ACTION_DECISION_SEEDS[idx % seeds_len]
    msg = memory[-1][1] if memory else ""
    return {
        "speaker": speaker, "agent": agent,
        "memory": memory[:-1], "current": msg,
        "rendered": (
            "Continue helping the user after reviewing the latest "
            "action results.\n\ncontext:\n(no providers)\n\n"
            f"recent conversation:\n"
            f"{render_recent(memory, speaker, agent)}\n\n"
            f"recent action results:\n{results}\n\n"
            "Emit ONE TOON document — no `TOON` header, no fences, no prose. "
            "Use exactly this layout (replace placeholders, keep the array "
            "form for actions and providers):\n\n"
            "thought: <one or two sentences explaining the next step>\n"
            "actions[1]:\n"
            "  - name: REPLY\n"
            "    params:\n"
            "providers[0]:\n"
            "text: <user-facing reply, may be empty for IGNORE/STOP>\n"
            "simple: true"
        ),
    }


# ───────────────────────── task dispatch table ────────────────────────────

@dataclass
class TaskSpec:
    name: str          # task_type slug used for the runtime template registry
    builder: Any       # _build_* callable
    stub: Any          # stub_* callable
    validator: Any     # validate_* callable
    teacher_system: str


_TOON_PREAMBLE = (
    "Output format: TOON, NOT JSON. Do NOT wrap output in `{` and `}`. "
    "Do NOT quote keys with double quotes (use bare `key:`). Do NOT emit "
    "a `TOON` or `JSON` header line. Do NOT use markdown bullets — use "
    "TOON array form (`key[N]:` followed by `  - item` lines). Emit "
    "exactly one TOON document, nothing before or after.\n\n"
)


TASKS: dict[str, TaskSpec] = {
    "reply": TaskSpec(
        name="reply",
        builder=_build_reply,
        stub=stub_reply,
        validator=validate_reply,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS REPLY action handler. Emit ONE TOON "
            "document with `thought` and `text`. Both values must be "
            "ONE LINE — no embedded newlines, no code blocks, no "
            "markdown lists. Use `\\n` literal escapes if you must "
            "indicate a newline in `text`. Wrap any multiline content "
            "in JSON-style double quotes. Example shape:\n\n"
            "thought: short reason for the reply\n"
            "text: \"the user-facing reply, one line, may contain \\n escapes\""
        ),
    ),
    "remove_contact": TaskSpec(
        name="remove_contact",
        builder=_build_remove_contact,
        stub=stub_remove_contact,
        validator=validate_remove_contact,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS REMOVE_CONTACT action handler. Emit ONE "
            "TOON document with `contactName` and `confirmed` "
            "(yes / no). Nothing else."
        ),
    ),
    "extract_option": TaskSpec(
        name="extract_option",
        builder=_build_extract_option,
        stub=stub_extract_option,
        validator=validate_extract_option,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS EXTRACT_OPTION action handler. Emit ONE "
            "TOON document with scalar `taskId` and `selectedOption`. "
            "Use null where the user didn't supply a value. DO NOT use "
            "array form. Example shape:\n\n"
            "taskId: deploy-task-91ab\n"
            "selectedOption: A"
        ),
    ),
    "extract_secret_operation": TaskSpec(
        name="extract_secret_operation",
        builder=_build_extract_secret_operation,
        stub=stub_extract_secret_operation,
        validator=validate_extract_secret_operation,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS EXTRACT_SECRET_OPERATION action handler. "
            "Determine the get/set/delete/list/check operation, the key, "
            "and value if present. All four fields are scalars — DO NOT "
            "use array form. Example shape:\n\n"
            "operation: get\n"
            "key: openai_key\n"
            "value: null\n"
            "level: null"
        ),
    ),
    "extract_secret_request": TaskSpec(
        name="extract_secret_request",
        builder=_build_extract_secret_request,
        stub=stub_extract_secret_request,
        validator=validate_extract_secret_request,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS EXTRACT_SECRET_REQUEST action handler. "
            "Identify the secret the agent needs and a short reason. "
            "Both `key` and `reason` are scalars (one string each). DO "
            "NOT use array form (`key[N]:`). Example shape:\n\n"
            "key: OPENAI_API_KEY\n"
            "reason: Needed to call OpenAI API"
        ),
    ),
    "post_creation": TaskSpec(
        name="post_creation",
        builder=_build_post_creation,
        stub=stub_post_creation,
        validator=validate_post_creation,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS POST_CREATION action handler. Emit ONE "
            "TOON document with `thought`, `post`, and an optional "
            "`imagePrompt`. Post must be < 280 chars."
        ),
    ),
    "post_action_decision": TaskSpec(
        name="post_action_decision",
        builder=_build_post_action_decision,
        stub=stub_post_action_decision,
        validator=validate_post_action_decision,
        teacher_system=(
            _TOON_PREAMBLE +
            "You are the elizaOS POST_ACTION_DECISION handler. Decide "
            "whether to REPLY, IGNORE, or STOP given the latest action "
            "results. Emit ONE TOON document with the planner-envelope "
            "fields: `thought`, `actions[N]`, `providers`, `text`, "
            "`simple`."
        ),
    ),
}


# ───────────────────────── synthesis driver ───────────────────────────────


def _generate_one(
    *, task: TaskSpec, idx: int, rng: random.Random, encoder: ToonEncoder,
    teacher: TeacherCfg, dry_run: bool,
) -> dict[str, Any] | None:
    scenario = task.builder(rng, idx)
    if dry_run:
        target_text = task.stub(encoder, rng, idx)
    else:
        target_text = normalize_teacher_output(call_teacher(
            teacher, task.teacher_system, scenario["rendered"],
        ))
    if not task.validator(target_text):
        return None
    # Reject anything we can't actually TOON-decode — synth-time validators
    # are regex-only and will pass nested objects / mid-line bullets that
    # the runtime decoder rejects. Better to drop now than discover at
    # train time.
    try:
        ToonDecoder().decode(target_text)
    except (ValueError, RuntimeError):
        return None
    memory_entries = to_memory_entries(
        scenario["speaker"], scenario["agent"], scenario["memory"],
    )
    current = {
        "role": "user", "speaker": scenario["speaker"],
        "content": scenario["current"], "channel": "dm",
    }
    rec = build(
        roomName=stable_id("synth-phase3", task.name, idx, target_text)[:12],
        agentId=scenario["agent"].lower(),
        memoryEntries=memory_entries,
        currentMessage=current,
        expectedResponse=target_text,
        availableActions=[],
        task_type=task.name,
        source_dataset=f"synth-phase3-{task.name}",
        license="synthetic",
        split="train",
        extra_metadata={
            "synth_task": task.name,
            "teacher_model": teacher.model,
            "system_prompt": scenario["rendered"],
        },
    )
    ok, _ = rec.is_valid()
    if not ok:
        return None
    return rec.to_dict()


def synthesize(
    *, task: TaskSpec, n: int, seed: int, teacher: TeacherCfg,
    encoder: ToonEncoder, out_path: Path, dry_run: bool, max_workers: int,
) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    records: list[dict[str, Any]] = []
    if dry_run:
        sub_rng = random.Random(rng.random())
        for idx in range(n):
            r = _generate_one(
                task=task, idx=idx, rng=sub_rng, encoder=encoder,
                teacher=teacher, dry_run=True,
            )
            if r is not None:
                records.append(r)
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            sub_rngs = [random.Random(rng.randrange(1 << 31)) for _ in range(n)]
            futs = {
                ex.submit(_generate_one, task=task, idx=i, rng=sub_rngs[i],
                          encoder=encoder, teacher=teacher,
                          dry_run=False): i
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
    with out_path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
    log.info("[%s] wrote %d records → %s", task.name, len(records), out_path)
    return len(records)


# ───────────────────────── CLI ────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--per-task", type=int, default=3000,
                    help="records per action (default: 3000)")
    ap.add_argument("--only", choices=tuple(TASKS.keys()) + ("all",),
                    default="all")
    ap.add_argument("--teacher-model", default="claude-opus-4-7")
    ap.add_argument("--teacher-provider", default="anthropic")
    ap.add_argument("--max-workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0xAC710F)
    ap.add_argument("--out", type=Path, default=OUT_DIR,
                    help="output directory (default: data/synthesized/phase3)")
    ap.add_argument("--dry-run", action="store_true",
                    help="emit 5 records per action with a stub teacher")
    args = ap.parse_args()

    out_dir: Path = args.out
    if args.dry_run:
        args.per_task = 5

    teacher = TeacherCfg(provider=args.teacher_provider, model=args.teacher_model)
    encoder = ToonEncoder()
    try:
        names = list(TASKS.keys()) if args.only == "all" else [args.only]
        total = 0
        for name in names:
            task = TASKS[name]
            out_path = out_dir / f"{name}.jsonl"
            log.info("synthesizing %d records for action=%s",
                     args.per_task, name)
            total += synthesize(
                task=task, n=args.per_task,
                seed=args.seed ^ (hash(name) & 0xFFFFFFFF),
                teacher=teacher, encoder=encoder,
                out_path=out_path, dry_run=args.dry_run,
                max_workers=args.max_workers,
            )
        log.info("done — wrote %d records across %d actions",
                 total, len(names))
    finally:
        encoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
