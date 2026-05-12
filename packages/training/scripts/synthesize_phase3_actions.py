"""Phase-3 (action-handler) datasets in the canonical `eliza_native_v1` shape.

Several runtime actions make their own LLM call inside `action.handler()`
(`REPLY` → `replyTemplate`, `CHOOSE_OPTION`/`EXTRACT_OPTION` →
`optionExtractionTemplate`, `EXTRACT_SECRET_OPERATION`/`EXTRACT_SECRET_REQUEST`,
`POST` creation → `postCreationTemplate`, `REMOVE_CONTACT` →
`removeContactTemplate`, plus the post-action continuation which re-enters the
planner). Those calls are tagged `purpose: "action"` in trajectory logging —
see `docs/dataset/RUNTIME_PHASES.md` §"Phase 3".

The previous generation of this corpus
(`data/synthesized/phase3/_backup/*.jsonl`) used the legacy flat `ElizaRecord`
envelope with a TOON `expectedResponse` (`thought: ...\ntext: ...`) and an
empty `availableActions:[]`. The runtime moved on: structured handlers now
return JSON objects, replies return `{thought,text}` JSON, and the canonical
corpus record is `eliza_native_v1` (one Vercel AI SDK `generateText` boundary
row). This module reads the legacy rows, re-renders the input against the
*current* runtime templates (`eliza/packages/prompts/src/index.ts`), converts
the TOON target to JSON, and writes `eliza_native_v1` rows.

Deterministic, no API key. If the legacy `_backup` rows are absent it falls
back to the live `data/synthesized/phase3/*.jsonl` files.

Run:
    .venv/bin/python scripts/synthesize_phase3_actions.py
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.native_record import native_text_record, native_tool_call_record, stable_id, write_jsonl  # noqa: E402
from lib.toon import ToonDecoder  # noqa: E402

PHASE3_DIR = ROOT / "data" / "synthesized" / "phase3"
BACKUP_DIR = PHASE3_DIR / "_backup"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-phase3")

# Task types this module owns and the runtime template each maps to.
TASK_TYPES = [
    "reply",
    "extract_option",
    "extract_secret_operation",
    "extract_secret_request",
    "post_creation",
    "post_action_decision",
    "remove_contact",
]


# ─── current runtime templates (verbatim from packages/prompts/src/index.ts) ──

REPLY_TEMPLATE = """# Task: Generate dialog for character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought": short description of what the agent is thinking and planning.
"text": next message {{agentName}} will send.

CODE BLOCK FORMATTING:
- For code examples, snippets, or multi-line code, ALWAYS wrap with ``` fenced code blocks (specify language if known, e.g., ```python).
- ONLY use fenced blocks for actual code. Do NOT wrap non-code text in fences.
- For inline code (short single words or function names), use single backticks (`).
- This ensures clean, copyable code formatting.

No <think> sections, no preamble.

JSON:
thought: Your thought here
text: Your message here

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

OPTION_EXTRACTION_TEMPLATE = """# Task: Extract selected task and option from user message

# Available Tasks:
{{tasks}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Identify which task and option the user is selecting
2. Match against available tasks and options, including ABORT
3. Return task ID (shortened UUID) and option name exactly as listed
4. If no clear selection, return null for both

JSON:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

EXTRACT_SECRET_OPERATION_TEMPLATE = """Manage secrets for an AI agent.

Determine the operation:
- get: Retrieve a secret value
- set: Store a new secret
- delete: Remove a secret
- list: Show all secrets (without values)
- check: Check if a secret exists

Common patterns:
- "What is my OpenAI key?" -> operation: get, key: OPENAI_API_KEY
- "Do I have a Discord token set?" -> operation: check, key: DISCORD_BOT_TOKEN
- "Show me my secrets" -> operation: list
- "Delete my old API key" -> operation: delete
- "Remove TWITTER_API_KEY" -> operation: delete, key: TWITTER_API_KEY
- "Set my key to sk-..." -> operation: set, key: <infer>, value: sk-...

{{recentMessages}}

Extract operation, key (if applicable), value (if applicable), level, description, and type.

Output JSON only. One JSON object, no prose or fences.
Use only these fields:
operation: get|set|delete|list|check
key: OPENAI_API_KEY
value: secret_value
level: global|world|user
description: short_description
type: api_key|secret|credential|url|config

Omit unknown optional fields. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

EXTRACT_SECRET_REQUEST_TEMPLATE = """An AI agent is requesting a missing secret.
Determine which secret and why from recent conversation.

Common patterns:
- "I need an API key for OpenAI" -> key: OPENAI_API_KEY
- "Missing TWITTER_TOKEN" -> key: TWITTER_TOKEN
- "I cannot proceed without a Discord token" -> key: DISCORD_TOKEN

Recent Messages:
{{recentMessages}}

Output JSON only. One JSON object, no prose or fences.
Use:
key: OPENAI_API_KEY
reason: why it is needed

If no specific secret requested, leave key empty. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

POST_CREATION_TEMPLATE = """# Task: Create a post in the voice/style/perspective of {{agentName}} @{{xUserName}}.

{{providers}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from {{agentName}}'s perspective. No commentary, no acknowledgement, just the post.
1, 2, or 3 sentences (random length).
No questions. Brief, concise statements only. Total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.

Output JSON:
thought: Your thought here
post: Your post text here
imagePrompt: Optional image prompt here

"post": the post you want to send. No thinking or reflection.
"imagePrompt": optional, single sentence capturing the post's essence. Only use if the post benefits from an image.
"thought": short description of what the agent is thinking, with brief justification. Explain how the post is relevant but unique vs other posts.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

REMOVE_CONTACT_TEMPLATE = """task: Extract the contact removal request.

context:
{{providers}}

current_message:
{{message}}

instructions[4]:
- identify contact name to remove
- confirmed=yes only when user explicitly confirms
- confirmed=no when ambiguous or absent
- return only the requested contact

output:
JSON only. One JSON object. No prose, no <think>.

Example:
contactName: Jane Doe
confirmed: yes

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

# Post-action continuation re-enters the planner; system mirrors the planner stage.
POST_ACTION_PLANNER_SYSTEM = """user_role: OWNER

planner_stage:
task: Continue helping the user after reviewing the latest action results.

rules:
- if more tool work remains, emit native toolCalls; otherwise return no toolCalls and set messageToUser
- messageToUser is the user-facing reply; never put thoughts, tool names, or analysis in it
- {{agentName}} keeps replies short and direct

context:
{{providers}}

recent action results:
{{actionResults}}"""


def _render(template: str, *, agent_name: str, providers: str, recent_messages: str,
            message: str = "", tasks: str = "", action_results: str = "(no recent action results)",
            adjective: str = "thought-provoking", topic: str = "the work",
            x_user_name: str = "agent") -> str:
    out = template
    out = out.replace("{{agentName}}", agent_name)
    out = out.replace("{{xUserName}}", x_user_name)
    out = out.replace("{{providers}}", providers or "(no providers)")
    out = out.replace("{{recentMessages}}", recent_messages)
    out = out.replace("{{recentInteractions}}", recent_messages)
    out = out.replace("{{message}}", message or recent_messages)
    out = out.replace("{{tasks}}", tasks or "(no pending tasks)")
    out = out.replace("{{actionResults}}", action_results)
    out = out.replace("{{adjective}}", adjective)
    out = out.replace("{{topic}}", topic)
    return out.strip()


# ─── legacy-row helpers ──────────────────────────────────────────────────

def _conversation_lines(legacy: dict[str, Any]) -> tuple[str, str, str]:
    """Return (recentMessages text, current user message text, agent display name)."""
    raw = legacy.get("agentId", "agent")
    agent_disp = raw[:1].upper() + raw[1:] if raw else "Agent"
    # prefer the display name actually used in the assistant turns, if present
    for m in legacy.get("memoryEntries") or []:
        if m.get("role") == "assistant" and m.get("speaker"):
            agent_disp = m["speaker"]
            break
    lines: list[str] = []
    for m in legacy.get("memoryEntries") or []:
        who = m.get("speaker") or (agent_disp if m.get("role") == "assistant" else "user")
        lines.append(f"{who}: {m.get('content', '')}")
    cur = legacy.get("currentMessage") or {}
    cur_speaker = cur.get("speaker") or "user"
    cur_text = cur.get("content", "")
    lines.append(f"{cur_speaker}: {cur_text}")
    return "\n".join(lines), cur_text, agent_disp


_decoder = ToonDecoder()


def _decode_target(expected: str) -> Any:
    expected = (expected or "").strip()
    if not expected:
        return {}
    if expected[0] in "[{":
        try:
            return json.loads(expected)
        except json.JSONDecodeError:
            pass
    try:
        return _decoder.decode(expected)
    except Exception:  # noqa: BLE001 — bad legacy rows are skipped
        return None


def _json_text(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ─── per-task-type conversion ────────────────────────────────────────────

def _convert_reply(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    thought = str(target.get("thought") or "")
    text = target.get("text")
    if text is None or str(text).strip() == "":
        return None
    system = _render(REPLY_TEMPLATE, agent_name=agent, providers="", recent_messages=recent)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text({"thought": thought, "text": text}),
        metadata=_meta(legacy, "reply"),
    )


def _convert_extract_option(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    task_id = target.get("taskId", target.get("taskID"))
    option = target.get("selectedOption", target.get("option"))
    # legacy system prompt embeds the "Available Tasks" block; reconstruct a thin one
    tasks_block = "- " + str(task_id) + ": see options offered above" if task_id else "(no pending tasks)"
    system = _render(OPTION_EXTRACTION_TEMPLATE, agent_name=agent, providers="", recent_messages=recent, tasks=tasks_block)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text({"taskId": task_id, "selectedOption": option}),
        metadata=_meta(legacy, "extract_option"),
    )


def _convert_secret_operation(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    obj: dict[str, Any] = {}
    op = target.get("operation")
    if op:
        obj["operation"] = op
    for k in ("key", "value", "level", "description", "type"):
        v = target.get(k)
        if v not in (None, "", "null"):
            obj[k] = v
    if not obj:
        obj = {"operation": op or "list"}
    system = _render(EXTRACT_SECRET_OPERATION_TEMPLATE, agent_name=agent, providers="", recent_messages=recent)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text(obj),
        metadata=_meta(legacy, "extract_secret_operation"),
    )


def _convert_secret_request(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    obj: dict[str, Any] = {}
    key = target.get("key")
    if key not in (None, "", "null"):
        obj["key"] = key
    reason = target.get("reason")
    if reason not in (None, "", "null"):
        obj["reason"] = reason
    if not obj:
        return None
    system = _render(EXTRACT_SECRET_REQUEST_TEMPLATE, agent_name=agent, providers="", recent_messages=recent)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text(obj),
        metadata=_meta(legacy, "extract_secret_request"),
    )


def _convert_post_creation(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    post = target.get("post")
    if post is None or str(post).strip() == "":
        return None
    obj: dict[str, Any] = {"thought": str(target.get("thought") or ""), "post": post}
    img = target.get("imagePrompt")
    if img not in (None, "", "null"):
        obj["imagePrompt"] = img
    # the legacy currentMessage was "please draft a post about <topic>" — pull the topic
    cur = (legacy.get("currentMessage") or {}).get("content", "")
    topic = cur.split("about", 1)[-1].strip() if "about" in cur else "the work"
    system = _render(POST_CREATION_TEMPLATE, agent_name=agent, providers="", recent_messages=recent, topic=topic)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text(obj),
        metadata=_meta(legacy, "post_creation"),
    )


def _convert_remove_contact(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    name = target.get("contactName")
    if name in (None, "", "null"):
        return None
    confirmed = target.get("confirmed")
    if isinstance(confirmed, bool):
        confirmed = "yes" if confirmed else "no"
    confirmed = str(confirmed or "no")
    cur = (legacy.get("currentMessage") or {}).get("content", "")
    system = _render(REMOVE_CONTACT_TEMPLATE, agent_name=agent, providers="", recent_messages=recent, message=cur)
    return native_text_record(
        system=system,
        user=recent,
        response_text=_json_text({"contactName": name, "confirmed": confirmed}),
        metadata=_meta(legacy, "remove_contact"),
    )


def _convert_post_action_decision(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    """The legacy TOON was the planner-envelope continuation. The current
    runtime continues via the planner: emit a native planner tool-call row."""
    if not isinstance(target, dict):
        return None
    thought = str(target.get("thought") or "")
    text = target.get("text")
    actions = target.get("actions") or []
    tool_calls: list[dict[str, Any]] = []
    for a in actions:
        if isinstance(a, dict) and a.get("name") and a["name"] not in ("IGNORE", "STOP"):
            params = a.get("params") or {}
            if not isinstance(params, dict):
                params = {}
            tool_calls.append({"name": a["name"], "args": params, "id": f"call_{len(tool_calls)}"})
    msg = text if (text and str(text).strip()) else None
    if not tool_calls and not msg:
        return None
    system = _render(POST_ACTION_PLANNER_SYSTEM, agent_name=agent, providers="", recent_messages=recent)
    return native_tool_call_record(
        system=system,
        turns=[{"role": "user", "content": "recent conversation:\n" + recent}],
        thought=thought,
        tool_calls=tool_calls,
        message_to_user=msg,
        metadata=_meta(legacy, "post_action_decision"),
    )


CONVERTERS = {
    "reply": _convert_reply,
    "extract_option": _convert_extract_option,
    "extract_secret_operation": _convert_secret_operation,
    "extract_secret_request": _convert_secret_request,
    "post_creation": _convert_post_creation,
    "post_action_decision": _convert_post_action_decision,
    "remove_contact": _convert_remove_contact,
}


def _meta(legacy: dict[str, Any], task_type: str) -> dict[str, Any]:
    src = legacy.get("metadata") or {}
    return {
        "task_type": task_type,
        "source_dataset": f"synth-phase3-{task_type}",
        "split": src.get("split", "train"),
        "synth_origin": "phase3-converted",
        "id": stable_id("phase3", task_type, json.dumps(legacy.get("currentMessage", {}), sort_keys=True),
                        legacy.get("expectedResponse", "")),
    }


# ─── source loading ──────────────────────────────────────────────────────

def _source_dir() -> Path:
    return BACKUP_DIR if BACKUP_DIR.is_dir() else PHASE3_DIR


def _iter_legacy(task_type: str) -> Iterable[dict[str, Any]]:
    path = _source_dir() / f"{task_type}.jsonl"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        # already in eliza_native_v1? leave it (idempotent re-run)
        if isinstance(row, dict) and row.get("format") == "eliza_native_v1":
            yield row
            continue
        if isinstance(row, dict) and "expectedResponse" in row:
            yield row


def convert_task(task_type: str) -> tuple[int, int]:
    conv = CONVERTERS[task_type]
    out_rows: list[dict[str, Any]] = []
    skipped = 0
    for legacy in _iter_legacy(task_type):
        if legacy.get("format") == "eliza_native_v1":
            out_rows.append(legacy)
            continue
        target = _decode_target(legacy.get("expectedResponse", ""))
        if target is None:
            skipped += 1
            continue
        recent, _cur, agent = _conversation_lines(legacy)
        rec = conv(legacy, target, recent, agent)
        if rec is None:
            skipped += 1
            continue
        out_rows.append(rec)
    out_path = PHASE3_DIR / f"{task_type}.jsonl"
    n = write_jsonl(out_rows, out_path)
    return n, skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", choices=TASK_TYPES, help="restrict to these task types")
    args = ap.parse_args()
    targets = args.only or TASK_TYPES
    src = _source_dir()
    log.info("source dir: %s", src)
    total = 0
    for tt in targets:
        n, skipped = convert_task(tt)
        total += n
        log.info("  %-26s -> %d rows (skipped %d)", tt, n, skipped)
    log.info("wrote %d phase-3 eliza_native_v1 rows under %s", total, PHASE3_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
