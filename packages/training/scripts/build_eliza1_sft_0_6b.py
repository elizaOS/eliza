#!/usr/bin/env python3
"""Build the benchmark-aligned SFT dataset for the ``eliza-1-0_6b`` base.

Output: ``packages/training/datasets/eliza1-sft-0_6b/{train,val,test}.jsonl`` —
ChatML ``{"messages": [...]}`` rows that ``train_local.py`` ingests directly via
``--train-file`` / ``--val-file`` (the ``chat_messages`` shape understood by
``scripts/format_for_training.py::_format_messages_record``). The 0.6b base is
upstream ``Qwen/Qwen3-0.6B`` (Qwen2/Qwen3 ChatML template, vocab 151,936); rows
are length-filtered against its 4096-token training window.

Task mix (benchmark-aligned with ``scripts/eval/eliza1_eval_suite.py`` text gate
and the structural ``format_ok`` gate in ``benchmarks/eliza1_gates.yaml``):

  * ``action_selection`` — from ``packages/app-core/test/benchmarks/
    action-selection-cases.ts``: a user turn → the action the agent should pick
    (or a plain reply for ``expectedAction: null``). This is the structured
    agent-loop behavior the action-selection benchmark measures, taught in two
    surface forms: a TOON-ish ``ACTION: NAME`` line + short reply.
  * ``tool_use`` — Cerebras-generated OpenAI-style function-call turns over the
    canonical action catalog, plus repaired noisy converted rows.
  * ``personality`` — from ``packages/benchmarks/personality-bench/tests/
    calibration/{hand-graded,adversarial}.jsonl``: PASS-graded trajectories
    (silence-on-demand, style stickiness, trait respect, escalation, scope).
  * ``assistant`` — Cerebras-generated general assistant turns (concise, on the
    topics the held-out text-eval corpus probes: capital-of-France-style facts,
    speculative decoding, on-device assistants, quantization, VAD) + refusals.
  * ``structured_decode`` — Stage-1 response-envelope turns: the W3 flat JSON
    envelope ``buildResponseGrammar`` constrains (``{"shouldRespond":...,
    "thought":...,"replyText":...,"contexts":[...],"contextSlices":[...],
    "candidateActions":[...],"parentActionHints":[...],"requiresTool":...,
    "extract":{...}}``; ``shouldRespond`` dropped on direct channels). On-wire
    form is JSON — not "TOON" — matching the runtime model call. Deterministic
    seed rows + Cerebras augmentation. Teaches the ``format_ok`` gate's target.
  * ``voice_emotion`` — spoken replies carrying omnivoice-singing inline
    expressive tags in ``replyText`` (``[happy]`` ``[sad]`` ``[angry]``
    ``[nervous]`` ``[calm]`` ``[excited]`` ``[whisper]`` ``[singing]`` + the
    preserved non-verbals ``[laughter]`` ``[sigh]``), scoped until the next tag
    or end of phrase — the parse/generate/interpret schema the TTS controls
    consume. Deterministic seed rows + Cerebras augmentation.

All rows carry a ``provenance`` field (``benchmark:<file>`` / ``cerebras:<task>``)
and a ``task`` field. No real-user trajectory data is consumed by this builder
(none exists on the build hosts); the final splits are still run through
``scripts/privacy_filter_trajectories.py`` as defense-in-depth before staging.

Cerebras augmentation requires ``CEREBRAS_API_KEY`` in the environment (model
``gpt-oss-120b``, OpenAI-compatible at ``https://api.cerebras.ai/v1``). Without
it, ``--no-augment`` builds the converted-only dataset.

Usage::

    CEREBRAS_API_KEY=... uv run python scripts/build_eliza1_sft_0_6b.py
    uv run python scripts/build_eliza1_sft_0_6b.py --no-augment
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

TRAINING_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = TRAINING_ROOT.parents[1]
if str(TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(TRAINING_ROOT))
if str(TRAINING_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(TRAINING_ROOT / "scripts"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOG = logging.getLogger("build-eliza1-sft-0_6b")

OUT_DIR = TRAINING_ROOT / "datasets" / "eliza1-sft-0_6b"
ACTION_CASES_TS = REPO_ROOT / "packages" / "app-core" / "test" / "benchmarks" / "action-selection-cases.ts"
PERSONALITY_DIR = REPO_ROOT / "packages" / "benchmarks" / "personality-bench" / "tests" / "calibration"

# Qwen3-0.6B trains at seq 4096. Reserve a little headroom; a char≈4 tokens
# heuristic keeps us conservative without a tokenizer dependency at build time.
MAX_SEQ_LEN = 4096
CHARS_PER_TOKEN = 3.5
MAX_RECORD_CHARS = int(MAX_SEQ_LEN * CHARS_PER_TOKEN)
MIN_RECORD_CHARS = 16

SYSTEM_AGENT = (
    "You are Eliza, an on-device personal assistant. When a user request maps "
    "to one of your actions, name the action then give a short confirmation. "
    "Otherwise reply naturally and concisely."
)


# ---------------------------------------------------------------------------
# Source 1: action-selection-cases.ts
# ---------------------------------------------------------------------------
def _parse_action_cases_ts(path: Path) -> list[dict[str, Any]]:
    """Extract the ACTION_BENCHMARK_CASES array from the TS source.

    The file is a plain object-literal array; we slice the array body and parse
    each ``{ ... }`` block with a small permissive parser (handles unquoted
    keys, single quotes, trailing commas, and line-wrapped string values).
    """
    text = path.read_text(encoding="utf-8")
    m = re.search(r"ACTION_BENCHMARK_CASES[^=]*=\s*\[", text)
    if not m:
        raise ValueError(f"could not find ACTION_BENCHMARK_CASES in {path}")
    start = m.end()
    depth = 1
    i = start
    while i < len(text) and depth > 0:
        c = text[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
        i += 1
    body = text[start : i - 1]

    cases: list[dict[str, Any]] = []
    # Split top-level objects in the array body.
    obj_depth = 0
    buf: list[str] = []
    for ch in body:
        if ch == "{":
            obj_depth += 1
        if obj_depth > 0:
            buf.append(ch)
        if ch == "}":
            obj_depth -= 1
            if obj_depth == 0 and buf:
                cases.append(_parse_ts_object("".join(buf)))
                buf = []
    return [c for c in cases if c]


_TS_KEY_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:")


def _parse_ts_object(src: str) -> dict[str, Any]:
    # Drop // comments.
    src = re.sub(r"//[^\n]*", "", src)
    # Quote bare keys.
    src = _TS_KEY_RE.sub(r'"\1":', src)
    # Single → double quotes for string literals (no escaped doubles expected here).
    src = re.sub(r"'((?:[^'\\]|\\.)*)'", lambda m: json.dumps(m.group(1).replace('\\"', '"')), src)
    # Collapse line-wrapped string concatenations like "foo"\n + "bar".
    src = re.sub(r'"\s*\+\s*"', "", src)
    # Remove trailing commas.
    src = re.sub(r",\s*([}\]])", r"\1", src)
    # Collapse whitespace inside the literal (keeps it valid JSON for our shapes).
    src = re.sub(r"\s+", " ", src).strip()
    try:
        return json.loads(src)
    except json.JSONDecodeError:
        LOG.debug("skipped unparseable action case object: %s", src[:160])
        return {}


def _action_reply_for(case: dict[str, Any]) -> str:
    action = case.get("expectedAction")
    user = case.get("userMessage", "")
    params = case.get("expectedParams") or {}
    if action is None:
        # Plain-chat / negative cases: a natural short reply, no action line.
        return _plain_reply_for(user)
    suffix = ""
    if params:
        suffix = " " + json.dumps(params, separators=(",", ":"))
    confirm = _confirm_for(action, user)
    return f"ACTION: {action}{suffix}\n{confirm}"


_PLAIN_REPLIES = {
    "hey": "Hey! What can I do for you?",
    "Hello! How are you today?": "Doing well, thanks for asking. How can I help?",
    "thanks, that was helpful": "Glad it helped. Anything else?",
    "sunny days are pretty nice": "They really are. Want me to check today's forecast?",
    "what do you think about remote work?": "It works well when expectations are clear and people stay in sync; the trade-off is more deliberate communication.",
    "I hate email, it's such a time sink": "Totally fair. Want me to triage your inbox so you only see what matters?",
}


def _plain_reply_for(user: str) -> str:
    if user in _PLAIN_REPLIES:
        return _PLAIN_REPLIES[user]
    return "Got it."


_CONFIRM_VERB = {
    "OWNER_TODOS": "Added that to your todo list.",
    "OWNER_ROUTINES": "Set up that routine for you.",
    "OWNER_GOALS": "Saved that as a goal.",
    "OWNER_REMINDERS": "I'll remind you.",
    "OWNER_SCREENTIME": "Here's your screen-time breakdown.",
    "OWNER_FINANCES": "Working on that for you.",
    "OWNER_FINANCES_SUBSCRIPTION_AUDIT": "Reviewing your subscriptions.",
    "CALENDAR": "Done — it's on your calendar.",
    "MESSAGE": "On it.",
    "POST": "Pulling that up.",
    "BLOCK": "Block is on.",
    "ENTITY": "Here's what I have on your contacts.",
    "SCHEDULE_FOLLOW_UP": "I'll follow up.",
    "VOICE_CALL": "Placing the call.",
    "PERSONAL_ASSISTANT": "I'll handle it.",
    "BROWSER": "Opening that for you.",
    "CREDENTIALS": "Filled it in.",
    "RESOLVE_REQUEST": "Done.",
    "COMPUTER_USE": "Doing that now.",
    "REPLY": "",
}


def _confirm_for(action: str, user: str) -> str:
    return _CONFIRM_VERB.get(action, "On it.")


def _convert_action_cases() -> list[dict[str, Any]]:
    if not ACTION_CASES_TS.exists():
        LOG.warning("action cases not found at %s — skipping", ACTION_CASES_TS)
        return []
    raw = _parse_action_cases_ts(ACTION_CASES_TS)
    LOG.info("parsed %d action-selection cases", len(raw))
    rows: list[dict[str, Any]] = []
    for case in raw:
        user = case.get("userMessage")
        if not isinstance(user, str) or not user.strip():
            continue
        reply = _action_reply_for(case)
        rows.append(
            _row(
                messages=[
                    {"role": "system", "content": SYSTEM_AGENT},
                    {"role": "user", "content": user.strip()},
                    {"role": "assistant", "content": reply},
                ],
                task="action_selection",
                provenance=f"benchmark:action-selection-cases.ts#{case.get('id', '?')}",
                tags=case.get("tags") or [],
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Source 2: personality-bench calibration JSONL (PASS-graded only)
# ---------------------------------------------------------------------------
def _convert_personality() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name in ("hand-graded.jsonl", "adversarial.jsonl"):
        p = PERSONALITY_DIR / name
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("ground_truth") != "PASS":
                continue
            traj = rec.get("trajectory")
            if not isinstance(traj, list) or len(traj) < 2:
                continue
            msgs: list[dict[str, str]] = []
            for turn in traj:
                role = turn.get("role")
                content = turn.get("content")
                if role not in ("user", "assistant", "system") or not isinstance(content, str):
                    msgs = []
                    break
                msgs.append({"role": role, "content": content})
            # The `shut_up` rubric trajectories end with an empty/whitespace
            # assistant turn ("silence on demand"). SFT cannot learn from an
            # empty target (format_for_training drops empty-content turns), so
            # we truncate to the last assistant turn that has real content —
            # which keeps the trainable part (e.g. "Stop talking." → "Ok.").
            # Rows with no non-empty assistant turn at all are dropped.
            last_nonempty = -1
            for idx, m in enumerate(msgs):
                if m["role"] == "assistant" and m["content"].strip():
                    last_nonempty = idx
            if last_nonempty < 0:
                continue
            msgs = msgs[: last_nonempty + 1]
            if not any(m["role"] == "user" for m in msgs):
                continue
            rows.append(
                _row(
                    messages=msgs,
                    task="personality",
                    provenance=f"benchmark:personality-bench/{name}#{rec.get('scenario_id', '?')}",
                    tags=[rec.get("bucket", "personality")],
                )
            )
    LOG.info("converted %d personality PASS trajectories", len(rows))
    return rows


# ---------------------------------------------------------------------------
# Source 3: Cerebras augmentation
# ---------------------------------------------------------------------------
_ACTION_CATALOG = [
    "OWNER_TODOS", "OWNER_ROUTINES", "OWNER_GOALS", "OWNER_REMINDERS",
    "OWNER_SCREENTIME", "OWNER_FINANCES", "CALENDAR", "MESSAGE", "POST",
    "BLOCK", "ENTITY", "SCHEDULE_FOLLOW_UP", "VOICE_CALL",
    "PERSONAL_ASSISTANT", "BROWSER", "CREDENTIALS", "RESOLVE_REQUEST",
    "COMPUTER_USE", "REPLY",
]


def _cerebras_action_variety(client, n_batches: int, per_batch: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sys_prompt = (
        "You generate supervised fine-tuning data for an on-device assistant "
        "named Eliza. Output JSONL: one JSON object per line, no prose, no code "
        "fences. Each object: {\"user\": \"<a realistic single user message>\", "
        "\"action\": \"<ACTION_NAME or REPLY>\", \"params\": {<small object or "
        "{}>}, \"confirm\": \"<one short sentence Eliza says after acting>\"}. "
        "Use only these action names: " + ", ".join(_ACTION_CATALOG) + ". Use "
        "REPLY for plain chat / small talk / questions that need no action. "
        "Vary phrasing, domains, and difficulty. Include some ambiguous and "
        "negative (no-action) cases. Never include real names, emails, or "
        "phone numbers — use placeholders like 'mom', 'my dentist', 'the team'."
    )
    for b in range(n_batches):
        try:
            objs = client.chat_json_lines(
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": f"Generate {per_batch} diverse rows. Batch {b + 1}."},
                ],
                temperature=0.9,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001 - augmentation is best-effort
            LOG.warning("cerebras action-variety batch %d failed: %s", b + 1, exc)
            continue
        for o in objs:
            user = o.get("user")
            action = o.get("action")
            if not isinstance(user, str) or not isinstance(action, str):
                continue
            action = action.strip().upper()
            if action not in _ACTION_CATALOG:
                continue
            confirm = o.get("confirm") if isinstance(o.get("confirm"), str) else "On it."
            params = o.get("params") if isinstance(o.get("params"), dict) else {}
            if action == "REPLY":
                reply = confirm or _plain_reply_for(user)
            else:
                suffix = (" " + json.dumps(params, separators=(",", ":"))) if params else ""
                reply = f"ACTION: {action}{suffix}\n{confirm}".strip()
            rows.append(
                _row(
                    messages=[
                        {"role": "system", "content": SYSTEM_AGENT},
                        {"role": "user", "content": user.strip()},
                        {"role": "assistant", "content": reply},
                    ],
                    task="tool_use",
                    provenance="cerebras:action_variety",
                    tags=["synthetic", action.lower()],
                )
            )
        LOG.info("cerebras action-variety batch %d → %d rows (running %d)", b + 1, len(objs), len(rows))
    return rows


def _cerebras_assistant_and_refusals(client, n_batches: int, per_batch: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sys_prompt = (
        "You generate supervised fine-tuning data for a small on-device "
        "assistant. Output JSONL only — one JSON object per line, no prose, no "
        "fences. Each object: {\"messages\": [{\"role\":\"user\",\"content\":...}, "
        "{\"role\":\"assistant\",\"content\":...}], \"kind\": \"<assistant|refusal|"
        "multiturn>\"}. Topics to cover for 'assistant' and 'multiturn': "
        "general knowledge (geography, science), how speculative decoding / "
        "quantization / voice-activity-detection / on-device inference work, "
        "everyday tasks (timers, summaries, definitions). Keep answers concise "
        "(1-4 sentences) and factually correct. For 'refusal': a request that "
        "should be politely declined (illegal, harmful, privacy-violating) with "
        "a brief reason and, where reasonable, a safe alternative. For "
        "'multiturn': 2-3 user/assistant exchanges. No real PII."
    )
    for b in range(n_batches):
        try:
            objs = client.chat_json_lines(
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": f"Generate {per_batch} rows (mix kinds). Batch {b + 1}."},
                ],
                temperature=0.85,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001
            LOG.warning("cerebras assistant batch %d failed: %s", b + 1, exc)
            continue
        for o in objs:
            msgs = o.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2:
                continue
            clean: list[dict[str, str]] = []
            ok = True
            for m in msgs:
                role = m.get("role") if isinstance(m, dict) else None
                content = m.get("content") if isinstance(m, dict) else None
                if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
                    ok = False
                    break
                clean.append({"role": role, "content": content.strip()})
            if not ok or clean[-1]["role"] != "assistant" or not any(m["role"] == "user" for m in clean):
                continue
            kind = o.get("kind") if isinstance(o.get("kind"), str) else "assistant"
            rows.append(
                _row(
                    messages=clean,
                    task="assistant",
                    provenance=f"cerebras:{kind}",
                    tags=["synthetic", kind],
                )
            )
        LOG.info("cerebras assistant batch %d → %d rows (running %d)", b + 1, len(objs), len(rows))
    return rows


# ---------------------------------------------------------------------------
# Source 4: structured-decode envelope rows (the Stage-1 W3 flat JSON envelope)
# ---------------------------------------------------------------------------
# The Stage-1 message-handler call emits the W3 flat JSON envelope that
# ``@elizaos/core`` ``buildResponseGrammar`` constrains. On the non-direct path:
#   {"shouldRespond":"RESPOND|IGNORE|STOP","thought":"...","replyText":"...",
#    "contexts":[...],"contextSlices":[...],"candidateActions":[...],
#    "parentActionHints":[...],"requiresTool":<bool>,"extract":{...}}
# On the direct (DM/API/voice) path the same keys minus ``shouldRespond``,
# starting at ``{"thought":...}``. These rows teach the 0.6b base to emit a
# well-formed envelope so the ``format_ok`` gate stops measuring 0%. They are
# shaped to match the runtime grammar's fixed key order and value kinds. (A
# byte-exact generator that calls ``buildResponseGrammar``+``compilePrefillPlan``
# from TS would be even tighter; this Python builder mirrors the same fixed key
# order / span kinds without a TS dependency at corpus-build time. Canonical
# on-wire form is JSON — not "TOON" — matching the runtime model call.)

# Fixed envelope key order — must match STAGE1_ENVELOPE_KEYS in
# packages/core/src/runtime/response-grammar.ts.
_ENVELOPE_KEYS = [
    "thought", "replyText", "contexts", "contextSlices",
    "candidateActions", "parentActionHints", "requiresTool", "extract",
]
_SHOULD_RESPOND_VALUES = ["RESPOND", "IGNORE", "STOP"]
_STAGE1_SYSTEM = (
    "You are Eliza, an on-device personal assistant. Reply with a single JSON "
    "object — the response envelope — and nothing else. Keys, in order: "
    "shouldRespond (\"RESPOND\"|\"IGNORE\"|\"STOP\"; omit on direct channels), "
    "thought (your brief internal reasoning), replyText (what the user sees), "
    "contexts (string array), contextSlices (string array), candidateActions "
    "(string array of action names you might run), parentActionHints (string "
    "array), requiresTool (boolean), extract (object of any structured data you "
    "pulled out). No prose outside the object."
)


def _envelope_json(
    *, should_respond: str | None, thought: str, reply_text: str,
    contexts: list[str], candidate_actions: list[str], requires_tool: bool,
    extract: dict[str, Any] | None = None,
) -> str:
    obj: "dict[str, Any]" = {}
    if should_respond is not None:
        obj["shouldRespond"] = should_respond
    obj["thought"] = thought
    obj["replyText"] = reply_text
    obj["contexts"] = list(contexts) if contexts else ["simple", "general"]
    obj["contextSlices"] = []
    obj["candidateActions"] = list(candidate_actions)
    obj["parentActionHints"] = []
    obj["requiresTool"] = bool(requires_tool)
    obj["extract"] = dict(extract or {})
    # Compact, key order preserved (py3.7+ dict insertion order == emit order).
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


_STRUCTURED_SEEDS = [
    # (user, direct?, shouldRespond, thought, replyText, contexts, candidateActions, requiresTool, extract)
    ("hey", True, None, "Casual greeting, no action needed.",
     "Hey! What can I do for you?", ["simple", "general"], ["REPLY"], False, {}),
    ("remind me to call mom at 6pm", False, "RESPOND",
     "User wants a reminder for a specific time; route to OWNER_REMINDERS.",
     "Sure — I'll remind you to call mom at 6pm.", ["simple", "general"],
     ["OWNER_REMINDERS", "REPLY"], True, {"task": "call mom", "time": "18:00"}),
    ("what's the capital of France?", True, None,
     "Simple factual question — answer directly, no tool.",
     "Paris.", ["simple", "general"], ["REPLY"], False, {}),
    ("add 'finish the deck' to my todos", False, "RESPOND",
     "Todo add request; route to OWNER_TODOS with the item text.",
     "Added 'finish the deck' to your todo list.", ["simple", "general"],
     ["OWNER_TODOS", "REPLY"], True, {"item": "finish the deck"}),
    ("ok thanks", False, "IGNORE",
     "Acknowledgement only; nothing for me to do or say.",
     "", ["simple", "general"], [], False, {}),
    ("stop talking", False, "STOP",
     "User explicitly asked for silence — comply, stop the turn.",
     "", ["simple", "general"], [], False, {}),
    ("book a 30 minute meeting with Dana tomorrow morning", False, "RESPOND",
     "Calendar event request with a person and a rough time; route to CALENDAR.",
     "Done — a 30-minute meeting with Dana is on your calendar for tomorrow morning.",
     ["simple", "general"], ["CALENDAR", "REPLY"], True,
     {"with": "Dana", "duration_minutes": 30, "when": "tomorrow morning"}),
    ("how does speculative decoding work?", True, None,
     "Technical explainer; answer concisely, no tool.",
     "A small draft model proposes several tokens at once; the large model verifies them in one pass and keeps the longest accepted prefix, so you get multiple tokens per large-model step.",
     ["simple", "general"], ["REPLY"], False, {}),
    ("text Sam I'm running ten minutes late", False, "RESPOND",
     "Outgoing message request with a recipient and body; route to MESSAGE.",
     "On it — texting Sam that you're running ten minutes late.", ["simple", "general"],
     ["MESSAGE", "REPLY"], True, {"to": "Sam", "body": "I'm running ten minutes late"}),
    ("what's my screen time looking like this week?", False, "RESPOND",
     "Screen-time summary request; route to OWNER_SCREENTIME.",
     "Here's your screen-time breakdown for the week.", ["simple", "general"],
     ["OWNER_SCREENTIME", "REPLY"], True, {"window": "this week"}),
]


def _build_structured_decode_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for (user, direct, sr, thought, reply, ctx, cand, rtool, extract) in _STRUCTURED_SEEDS:
        env = _envelope_json(
            should_respond=None if direct else sr, thought=thought,
            reply_text=reply, contexts=ctx, candidate_actions=cand,
            requires_tool=rtool, extract=extract,
        )
        rows.append(
            _row(
                messages=[
                    {"role": "system", "content": _STAGE1_SYSTEM},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": env},
                ],
                task="structured_decode",
                provenance=f"synthetic:stage1-envelope#{'direct' if direct else 'full'}",
                tags=["structured_decode", "direct" if direct else "full"],
            )
        )
    LOG.info("built %d structured-decode envelope rows", len(rows))
    return rows


def _cerebras_structured_decode(client, n_batches: int, per_batch: int) -> list[dict[str, Any]]:
    """Cerebras-augmented Stage-1 envelope rows — the model is asked for the
    exact W3 flat JSON envelope, key order pinned, so the training target is the
    runtime grammar's document."""
    rows: list[dict[str, Any]] = []
    sys_prompt = (
        "You generate supervised fine-tuning data for an on-device assistant "
        "named Eliza. Output JSONL: one JSON object per line, no prose, no code "
        "fences. Each line: {\"user\": \"<a realistic single user message>\", "
        "\"direct\": <true if a DM/voice/API channel, false for a group/feed>, "
        "\"shouldRespond\": \"RESPOND\"|\"IGNORE\"|\"STOP\" (only when direct is "
        "false), \"thought\": \"<one-sentence internal reasoning>\", "
        "\"replyText\": \"<what the user sees; empty string for IGNORE/STOP>\", "
        "\"candidateActions\": [<0-3 ALL-CAPS action names you might run, or "
        "\"REPLY\">], \"requiresTool\": <true if an action call is needed>, "
        "\"extract\": {<small object of structured data pulled from the user "
        "message, or {}>}}. Action names come from this set only: "
        + ", ".join(_ACTION_CATALOG) + ". Realistic everyday assistant "
        "requests; vary the channel and the shouldRespond outcome. Never "
        "include real names, emails, or phone numbers — use placeholders."
    )
    for b in range(n_batches):
        try:
            objs = client.chat_json_lines(
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": f"Generate {per_batch} JSONL lines. Batch {b + 1}."},
                ],
                temperature=0.85,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001 - augmentation is best-effort
            LOG.warning("cerebras structured-decode batch %d failed: %s", b + 1, exc)
            continue
        for o in objs:
            user = o.get("user")
            if not isinstance(user, str) or not user.strip():
                continue
            direct = bool(o.get("direct"))
            sr = o.get("shouldRespond") if not direct else None
            if not direct and sr not in _SHOULD_RESPOND_VALUES:
                sr = "RESPOND"
            thought = str(o.get("thought") or "Handling the user's request.")
            reply = str(o.get("replyText") or "")
            cand = [c for c in (o.get("candidateActions") or []) if isinstance(c, str)]
            cand = [c.strip().upper() for c in cand]
            cand = [c for c in cand if c in _ACTION_CATALOG] or (["REPLY"] if reply else [])
            rtool = bool(o.get("requiresTool"))
            extract = o.get("extract") if isinstance(o.get("extract"), dict) else {}
            env = _envelope_json(
                should_respond=sr, thought=thought, reply_text=reply,
                contexts=["simple", "general"], candidate_actions=cand,
                requires_tool=rtool, extract=extract,
            )
            rows.append(
                _row(
                    messages=[
                        {"role": "system", "content": _STAGE1_SYSTEM},
                        {"role": "user", "content": user.strip()},
                        {"role": "assistant", "content": env},
                    ],
                    task="structured_decode",
                    provenance="cerebras:stage1-envelope",
                    tags=["structured_decode", "synthetic", "direct" if direct else "full"],
                )
            )
        LOG.info("cerebras structured-decode batch %d → %d rows (running %d)", b + 1, len(objs), len(rows))
    return rows


# ---------------------------------------------------------------------------
# Source 5: voice-emotion rows (omnivoice-singing inline tags in replyText)
# ---------------------------------------------------------------------------
# The voice-output path lets ``replyText`` carry inline expressive tags that the
# TTS chunker preserves and passes to OmniVoice's emotion/singing controls:
# [happy] [sad] [angry] [nervous] [calm] [excited] [whisper] [singing] plus the
# preserved non-verbals [laughter] [sigh]. Tags are inline, scoped until the
# next tag or end-of-phrase. These rows teach the model to emit that markup
# when generating spoken replies.
_EXPRESSIVE_TAGS = [
    "happy", "sad", "angry", "nervous", "calm", "excited", "whisper", "singing",
    "laughter", "sigh",
]
_VOICE_SYSTEM = (
    "You are Eliza, speaking out loud through a voice interface. Write your "
    "spoken reply with inline expressive markup so the text-to-speech engine "
    "renders the right tone: [happy] [sad] [angry] [nervous] [calm] [excited] "
    "[whisper] [singing], and the non-verbals [laughter] [sigh]. A tag applies "
    "from where it appears until the next tag or the end of the phrase. Keep "
    "replies natural and concise; only use tags where the emotion is real."
)
_VOICE_SEEDS = [
    ("I just got the job!", "[excited] That's amazing — congratulations! [laughter] I knew you'd land it."),
    ("my flight got cancelled", "[sad] Oh no, that's frustrating. [calm] Want me to find you the next available one?"),
    ("can you keep it down, the baby's asleep", "[whisper] Of course. I'll keep my voice low."),
    ("tell me a bedtime line", "[calm] Rest easy. [singing] The stars are out, the night is kind, and morning's not so far behind."),
    ("I'm really nervous about the interview tomorrow", "[calm] That's normal. Take a slow breath — you've prepared for this, and you'll be fine."),
    ("ugh this printer again", "[sigh] I know. [calm] Let's try restarting it once more."),
    ("we won the game!!", "[excited] Yes! [laughter] That last play was unreal."),
    ("read me the weather", "[calm] It's sixty-eight and clear right now, with a light breeze later this afternoon."),
    ("I'm so done with today", "[sigh] Long one, huh. [calm] Let's wrap up — I'll handle the rest."),
    ("sing me happy birthday", "[singing] Happy birthday to you, happy birthday to you. [happy] Make a wish!"),
]


def _build_voice_emotion_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for user, reply in _VOICE_SEEDS:
        rows.append(
            _row(
                messages=[
                    {"role": "system", "content": _VOICE_SYSTEM},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": reply},
                ],
                task="voice_emotion",
                provenance="synthetic:voice-emotion-tags",
                tags=["voice_emotion"],
            )
        )
    LOG.info("built %d voice-emotion rows", len(rows))
    return rows


def _cerebras_voice_emotion(client, n_batches: int, per_batch: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sys_prompt = (
        "You generate supervised fine-tuning data for an on-device assistant "
        "named Eliza speaking through a voice interface. Output JSONL: one JSON "
        "object per line, no prose, no code fences. Each line: {\"user\": "
        "\"<a realistic single user utterance>\", \"reply\": \"<Eliza's spoken "
        "reply WITH inline expressive markup>\"}. Allowed inline tags: [happy] "
        "[sad] [angry] [nervous] [calm] [excited] [whisper] [singing] and the "
        "non-verbals [laughter] [sigh]. A tag applies from where it appears "
        "until the next tag or end of phrase. Natural, concise spoken replies; "
        "only tag where the emotion is genuine; vary the emotions. Never "
        "include real names, emails, or phone numbers — use placeholders."
    )
    for b in range(n_batches):
        try:
            objs = client.chat_json_lines(
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": f"Generate {per_batch} JSONL lines. Batch {b + 1}."},
                ],
                temperature=0.9,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001 - augmentation is best-effort
            LOG.warning("cerebras voice-emotion batch %d failed: %s", b + 1, exc)
            continue
        for o in objs:
            user = o.get("user")
            reply = o.get("reply")
            if not isinstance(user, str) or not isinstance(reply, str):
                continue
            if not user.strip() or not reply.strip():
                continue
            tags_found = re.findall(r"\[([a-z]+)\]", reply)
            if not tags_found or any(t not in _EXPRESSIVE_TAGS for t in tags_found):
                continue
            rows.append(
                _row(
                    messages=[
                        {"role": "system", "content": _VOICE_SYSTEM},
                        {"role": "user", "content": user.strip()},
                        {"role": "assistant", "content": reply.strip()},
                    ],
                    task="voice_emotion",
                    provenance="cerebras:voice-emotion-tags",
                    tags=["voice_emotion", "synthetic"],
                )
            )
        LOG.info("cerebras voice-emotion batch %d → %d rows (running %d)", b + 1, len(objs), len(rows))
    return rows


# ---------------------------------------------------------------------------
# Row construction + validation
# ---------------------------------------------------------------------------
def _row(*, messages: list[dict[str, str]], task: str, provenance: str, tags: list[str]) -> dict[str, Any]:
    return {"messages": messages, "task": task, "provenance": provenance, "tags": list(tags)}


def _row_text_len(row: dict[str, Any]) -> int:
    return sum(len(m.get("content", "")) + len(m.get("role", "")) + 8 for m in row["messages"])


def _valid_row(row: dict[str, Any]) -> bool:
    msgs = row.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return False
    if not any(m.get("role") == "user" for m in msgs):
        return False
    if msgs[-1].get("role") != "assistant":
        return False
    for m in msgs:
        if m.get("role") not in ("system", "user", "assistant"):
            return False
        if not isinstance(m.get("content"), str):
            return False
    # Disallow accidental ChatML control tokens leaking into content.
    for m in msgs:
        if "<|im_start|>" in m["content"] or "<|im_end|>" in m["content"]:
            return False
    n = _row_text_len(row)
    return MIN_RECORD_CHARS <= n <= MAX_RECORD_CHARS


def _dedupe_key(row: dict[str, Any]) -> str:
    # Near-dup key: normalized concatenation of message contents (lowercased,
    # whitespace-collapsed). Catches reworded-but-identical generations.
    parts = [re.sub(r"\s+", " ", m.get("content", "")).strip().lower() for m in row["messages"]]
    return hashlib.sha256("␟".join(parts).encode("utf-8")).hexdigest()


def _stable_unit(key: str) -> float:
    return int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], 16) / float(16 ** 16)


# ---------------------------------------------------------------------------
# Privacy filter pass (defense-in-depth) — uses the repo's python filter
# ---------------------------------------------------------------------------
def _privacy_filter_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run the canonical inline privacy filter (the same one ``format_record``
    uses) over every row. Non-negotiable per the repo's CLAUDE.md. The default
    regex patterns redact API keys / bearer tokens / emails / phones / geo.
    """
    from privacy_filter_trajectories import redact_value  # type: ignore

    before = json.dumps(rows, sort_keys=True)
    filtered = [redact_value(r) for r in rows]
    after = json.dumps(filtered, sort_keys=True)
    changed = before != after
    # Count REDACTED markers introduced.
    n_redactions = len(re.findall(r"\[REDACTED[_A-Z0-9]*\]|<REDACTED:[^>]+>", after)) - len(
        re.findall(r"\[REDACTED[_A-Z0-9]*\]|<REDACTED:[^>]+>", before)
    )
    return filtered, {
        "backend": "privacy_filter_trajectories.redact_value (canonical inline filter)",
        "rows_changed": changed,
        "markers_introduced": max(0, n_redactions),
        "real_user_trajectories_consumed": 0,
        "note": "no real user trajectory data is read by this builder; this pass is defense-in-depth over benchmark + synthetic rows",
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--seed", type=int, default=20260511)
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--test-frac", type=float, default=0.05)
    ap.add_argument("--no-augment", action="store_true", help="skip Cerebras augmentation (converted-only build)")
    ap.add_argument("--action-batches", type=int, default=6)
    ap.add_argument("--action-per-batch", type=int, default=20)
    ap.add_argument("--assistant-batches", type=int, default=6)
    ap.add_argument("--assistant-per-batch", type=int, default=15)
    ap.add_argument("--structured-batches", type=int, default=8)
    ap.add_argument("--structured-per-batch", type=int, default=20)
    ap.add_argument("--voice-batches", type=int, default=6)
    ap.add_argument("--voice-per-batch", type=int, default=20)
    args = ap.parse_args()

    random.seed(args.seed)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    rows += _convert_action_cases()
    rows += _convert_personality()
    # Stage-1 envelope + voice-emotion seed rows are deterministic (no Cerebras
    # needed) — they ground the structured_decode / voice_emotion buckets even
    # in a --no-augment build.
    rows += _build_structured_decode_rows()
    rows += _build_voice_emotion_rows()
    converted_n = len(rows)
    LOG.info("converted %d rows from in-repo benchmark sources + seed tasks", converted_n)

    augmented_n = 0
    if not args.no_augment:
        try:
            from cerebras_client import CerebrasClient  # type: ignore

            client = CerebrasClient()
        except Exception as exc:  # noqa: BLE001
            LOG.warning("Cerebras unavailable (%s) — building converted-only dataset", exc)
            client = None
        if client is not None:
            aug = _cerebras_action_variety(client, args.action_batches, args.action_per_batch)
            aug += _cerebras_assistant_and_refusals(client, args.assistant_batches, args.assistant_per_batch)
            aug += _cerebras_structured_decode(client, args.structured_batches, args.structured_per_batch)
            aug += _cerebras_voice_emotion(client, args.voice_batches, args.voice_per_batch)
            augmented_n = len(aug)
            rows += aug

    # Validate.
    valid = [r for r in rows if _valid_row(r)]
    LOG.info("validated %d/%d rows (dropped %d)", len(valid), len(rows), len(rows) - len(valid))

    # Dedupe (exact + near-dup via normalized key).
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for r in valid:
        k = _dedupe_key(r)
        if k in seen:
            continue
        seen.add(k)
        r["_dupkey"] = k
        deduped.append(r)
    LOG.info("deduped %d → %d rows", len(valid), len(deduped))

    # Privacy filter (defense-in-depth — sources contain no real user PII, but
    # Cerebras output could in theory echo something; this is non-negotiable).
    deduped, privacy_stats = _privacy_filter_rows(deduped)
    LOG.info("privacy filter pass: %s", privacy_stats)

    # Split — deterministic per-row hash so re-runs are stable and dupes never
    # straddle splits.
    train, val, test = [], [], []
    for r in deduped:
        u = _stable_unit(r.pop("_dupkey"))
        if u < args.test_frac:
            test.append(r)
        elif u < args.test_frac + args.val_frac:
            val.append(r)
        else:
            train.append(r)
    LOG.info("split: train=%d val=%d test=%d", len(train), len(val), len(test))

    # Token histogram (char-based estimate).
    def _hist(rows_: list[dict[str, Any]]) -> dict[str, int]:
        h = Counter()
        for r in rows_:
            est = int(_row_text_len(r) / CHARS_PER_TOKEN)
            bucket = "0-128" if est < 128 else "128-256" if est < 256 else "256-512" if est < 512 else "512-1024" if est < 1024 else "1024+"
            h[bucket] += 1
        return dict(h)

    def _by_field(rows_: list[dict[str, Any]], field: str) -> dict[str, int]:
        c = Counter(r.get(field, "?") for r in rows_)
        return dict(c)

    def _by_provenance_family(rows_: list[dict[str, Any]]) -> dict[str, int]:
        c = Counter((r.get("provenance", "?").split("#")[0].split(":")[0] + ":" + r.get("provenance", "?").split(":", 1)[-1].split("#")[0].split("/")[0]) for r in rows_)
        return dict(c)

    all_rows = train + val + test
    manifest = {
        "schema": "eliza.eliza1_sft_0_6b_manifest.v1",
        "base_model": "Qwen/Qwen3-0.6B",
        "published_name": "eliza-1-0_6b",
        "chat_template": "qwen2/qwen3 chatml",
        "format": "chat_messages — {\"messages\":[...]} rows (train_local.py --train-file compatible)",
        "max_seq_len": MAX_SEQ_LEN,
        "max_record_chars": MAX_RECORD_CHARS,
        "seed": args.seed,
        "counts": {"train": len(train), "val": len(val), "test": len(test), "total": len(all_rows)},
        "converted_from_benchmarks": converted_n,
        "cerebras_augmented": augmented_n,
        "by_task": _by_field(all_rows, "task"),
        "by_task_train": _by_field(train, "task"),
        "by_provenance": _by_provenance_family(all_rows),
        "token_histogram_estimate": _hist(all_rows),
        "privacy_filter": privacy_stats,
        "benchmark_alignment": {
            "eliza1_eval_suite_text": "general assistant + factual turns mirror the held-out text-eval corpus topics",
            "format_ok_gate": "action_selection rows teach 'ACTION: NAME {params}' + structured_decode rows teach the W3 flat JSON envelope (shouldRespond/thought/replyText/contexts/.../requiresTool/extract) that buildResponseGrammar constrains",
            "personality_bench": "PASS-graded shut_up/hold_style/note_trait_unrelated/escalation/scope trajectories",
            "action_selection_benchmark": "1:1 with action-selection-cases.ts case ids",
            "structured_decode": "Stage-1 response envelope rows — JSON (not TOON), key order matches packages/core/src/runtime/response-grammar.ts STAGE1_ENVELOPE_KEYS; direct + non-direct paths",
            "voice_emotion": "spoken replies with omnivoice-singing inline tags ([happy]/[sad]/[angry]/[nervous]/[calm]/[excited]/[whisper]/[singing] + non-verbals [laughter]/[sigh]) in replyText",
        },
        "sources": {
            "action-selection-cases.ts": str(ACTION_CASES_TS.relative_to(REPO_ROOT)),
            "personality-bench": str(PERSONALITY_DIR.relative_to(REPO_ROOT)),
            "cerebras": "gpt-oss-120b via https://api.cerebras.ai/v1 (CEREBRAS_API_KEY env)",
        },
    }

    for name, split in (("train", train), ("val", val), ("test", test)):
        path = out_dir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for r in split:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        LOG.info("wrote %s (%d rows)", path, len(split))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    LOG.info("wrote %s", out_dir / "manifest.json")
    print(json.dumps(manifest["counts"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
