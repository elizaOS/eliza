"""Per-source-format adapters for the normalizer.

Every adapter yields the DEPRECATED flat `ElizaRecord` shape (see
`scripts/lib/eliza_record.py`). That intermediate is converged to the rendered
ChatML training example by `scripts/format_for_training.py`. It is NOT the
canonical Eliza-1 corpus record — that is `eliza_native_v1`; see
`packages/training/docs/dataset/CANONICAL_RECORD.md`. No new adapter should be
added here; new corpus data should be authored as `eliza_native_v1` rows.

Current canonical action vocabulary (used in `availableActions`; mirror
`packages/core/src/generated/action-docs.ts`):

    RESPOND, IGNORE, STOP   — shouldRespond decision values (not actions)
    REPLY                   — emit a reply (similes RESPOND/RESPONSE/GREET)
    SHELL                   — execute a shell command
    TASKS                   — orchestrator action (spawn / send / stop / history / share / call)
    USE_SKILL / SKILL       — invoke an enabled skill / skill-catalog ops
    APP, GENERATE_MEDIA, CHOOSE_OPTION, ...  — plus per-tool / per-skill custom names

The supervised target is `expectedResponse` (a JSON planner document for
structured tasks, plain text for replies). Legacy TOON output is only for
compatibility rebuilds that pass a legacy encoder from
`normalize.py --expected-response-format legacy-toon`.
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
from typing import Any, Callable, Iterator

from .eliza_record import (
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_RESPOND,
    ACTION_SHELL,
    ACTION_TASKS,
    DEFAULT_THOUGHT_LEAKS,
    ElizaRecord,
    REPLY_ACTIONS,
    ROUTING_ACTIONS,
    build,
    is_default_thought_leak,
    stable_id,
)
from .expected_response import ExpectedResponseEncoder

log = logging.getLogger("adapter")

# Regression guard: the literal default-thought strings the legacy adapters
# injected as a fallback `thought` whenever the upstream record lacked a real
# reasoning trace are forbidden from re-entering this module as defaults.
# DEFAULT_THOUGHT_LEAKS is the canonical leak list (see lib/eliza_record.py);
# this assertion fails fast at import time if anyone re-introduces them as
# adapter-default constants.
assert "Reply to the user." in DEFAULT_THOUGHT_LEAKS
assert "Call the tool to satisfy the request." in DEFAULT_THOUGHT_LEAKS

# Every adapter has the same call signature. `records` is whatever
# `normalize.py:load_records()` yields — JSONL/JSON/parquet rows decoded
# into dicts; the `_source_filename` injection lets file-aware adapters
# pick a task_type per shard. Adapters yield canonical `ElizaRecord`s.
Adapter = Callable[..., Iterator[ElizaRecord]]

ROLE_MAP = {
    "user": "user", "human": "user", "USER": "user", "question": "user",
    "assistant": "assistant", "gpt": "assistant", "model": "assistant",
    "ai": "assistant", "ASSISTANT": "assistant",
    "answer": "assistant", "response": "assistant", "agent": "assistant",
    "bot": "assistant",
    "system": "system", "SYSTEM": "system", "developer": "system",
    "tool": "tool", "function": "tool", "tool_response": "tool",
    "observation": "tool", "tool_result": "tool", "function_response": "tool",
    "tool call": "assistant", "tool_call": "assistant",
    # Some sources (regularizer-reasoning-tool) ship a separate
    # "reasoning" role that PRECEDES the corresponding assistant turn.
    # We tag it explicitly here so `_split_history` can attach it as the
    # `thought` of the next assistant turn rather than dropping it.
    "reasoning": "reasoning", "thought": "reasoning",
    "analysis": "reasoning",
}


def _norm_role(r: str) -> str:
    if not r:
        return "user"
    return ROLE_MAP.get(r, ROLE_MAP.get(r.lower(), r.lower()))


def _strip_surrogates(s: str) -> str:
    """Remove unpaired surrogate codepoints. Some upstream JSON (notably
    agent-trove parquet shards from terminus-2 traces) contains lone
    `\\udcca` bytes — these survive the parquet decode but break the
    bun encoder's `stdin.write` because Python's UTF-8 encoder rejects
    surrogates. Replacing is safe: these are byte-level garbage from
    the upstream, never meaningful glyphs."""
    if not isinstance(s, str):
        return s
    return s.encode("utf-8", "replace").decode("utf-8", "replace")


def _split_history(messages: list[dict[str, Any]]) -> tuple[
    str, list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None
]:
    """Return (system_prompt, memoryEntries, currentMessage, finalAssistant).

    The first system turn(s) collapse into `system_prompt` (returned
    separately so adapters can stash it under metadata). The last assistant
    turn becomes the supervised target. The last user turn before that
    becomes `currentMessage`.
    """
    system_parts: list[str] = []
    convo: list[dict[str, Any]] = []
    for m in messages:
        # Defensive: some sources mix in plain-string entries inside the
        # messages list (e.g. open-paws-tool-use, toucan, regularizer).
        # Treat a bare string as a user turn so we don't lose the record.
        if isinstance(m, str):
            m = {"role": "user", "content": m}
        elif not isinstance(m, dict):
            continue
        role = _norm_role(m.get("role") or m.get("from") or "")
        content = m.get("content") if "content" in m else m.get("value")
        # Keep an assistant turn even when content is null IF it carries
        # tool_calls — that's how OpenAI ships function-only assistant turns
        # (e.g. google/mobile-actions). _extract_tool_calls reads from raw.
        if content is None:
            if role == "assistant" and (m.get("tool_calls") or m.get("function_call")):
                content = ""
            else:
                continue
        if isinstance(content, list):
            content = "".join(
                p.get("text", "") if isinstance(p, dict) else str(p)
                for p in content
            )
        if role == "system":
            system_parts.append(str(content))
            continue
        if role == "reasoning":
            # Hold this thought; attach to the next assistant turn we see.
            # Strip <think> wrappers if the upstream source still has them.
            txt = str(content).strip()
            mt = re.match(r"<think>([\s\S]*?)</think>\s*", txt)
            if mt:
                txt = mt.group(1).strip()
            convo.append({"role": "reasoning", "content": txt, "raw": m})
            continue
        entry: dict[str, Any] = {"role": role, "content": str(content), "raw": m}
        # Some sources ship a sibling reasoning/thinking field on the
        # assistant message itself (opus-46-10kx-bas95: `reasoning`;
        # talos-kimi/Kimi-style traces: `thinking`; a few qwen3 dumps
        # use `thought`). Capture it so we can populate `thought:` later.
        if role == "assistant":
            for key in ("reasoning", "thinking", "thought", "reasoning_content"):
                v = m.get(key)
                if isinstance(v, str) and v.strip():
                    entry["_pending_thought"] = v.strip()
                    break
        convo.append(entry)

    # Coalesce any pending reasoning-role messages into the *next* assistant
    # turn's `_pending_thought` field, then drop the reasoning entries from
    # the conversation. This keeps the standard memory/history clean while
    # preserving the upstream reasoning so we can use it as `thought:`.
    coalesced: list[dict[str, Any]] = []
    pending_thoughts: list[str] = []
    for m in convo:
        if m["role"] == "reasoning":
            if m["content"]:
                pending_thoughts.append(m["content"])
            continue
        if m["role"] == "assistant" and pending_thoughts:
            existing = m.get("_pending_thought") or ""
            joined = "\n\n".join([t for t in [existing, *pending_thoughts] if t]).strip()
            m = {**m, "_pending_thought": joined}
            pending_thoughts = []
        coalesced.append(m)
    convo = coalesced

    # Find the last assistant turn anywhere in the convo (not just at the
    # tail). Agent traces (swebench, hf-coding-tools) often end on a user
    # `tool_output` turn — we still want to train on the previous assistant
    # action that PRECEDED it.
    final_assistant: dict[str, Any] | None = None
    final_idx = -1
    for i in range(len(convo) - 1, -1, -1):
        if convo[i]["role"] == "assistant":
            final_assistant = convo[i]
            final_idx = i
            break
    if final_assistant is not None:
        # Drop the final assistant turn AND anything after it (subsequent
        # user/tool turns aren't part of this training record).
        convo = convo[:final_idx]

    current_msg: dict[str, Any] | None = None
    for m in reversed(convo):
        if m["role"] == "user":
            current_msg = {
                "role": "user",
                "speaker": "user",
                "content": m["content"],
                "channel": "dm",
            }
            convo.remove(m)
            break

    memory = [
        {
            "role": m["role"],
            "speaker": m["role"],
            "content": m["content"],
            "channel": "dm",
        }
        for m in convo
    ]
    return "\n\n".join(system_parts), memory, current_msg, final_assistant


def _parse_apigen_calls(text: str) -> list[dict[str, Any]]:
    """Parse APIGen-style ``[Name(arg=val, ...), Name2(...)]`` into tool_calls.

    Handles dotted names (``Module.method``), names with embedded spaces
    (``Manufacturing PMI``), nested literals (lists/dicts), and quoted
    strings via Python's ast module.
    """
    text = (text or "").strip()
    if not (text.startswith("[") and text.endswith("]")):
        return []
    inner = text[1:-1].strip()
    if not inner:
        return []
    # Split top-level call boundaries (commas at depth 0, outside strings).
    depth = 0
    in_str: str | None = None
    starts = [0]
    prev = ""
    for i, c in enumerate(inner):
        if in_str:
            if c == in_str and prev != "\\":
                in_str = None
            prev = c
            continue
        if c in ("\"", "'"):
            in_str = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            starts.append(i + 1)
        prev = c
    parts: list[str] = []
    for j, s in enumerate(starts):
        e = starts[j + 1] - 1 if j + 1 < len(starts) else len(inner)
        parts.append(inner[s:e].strip())

    calls: list[dict[str, Any]] = []
    for part in parts:
        # Find the leftmost top-level '(' as the start of arguments. Names
        # may contain dots, hyphens, and even spaces.
        depth2 = 0
        open_idx = -1
        in_str2: str | None = None
        prev2 = ""
        for i, c in enumerate(part):
            if in_str2:
                if c == in_str2 and prev2 != "\\":
                    in_str2 = None
                prev2 = c
                continue
            if c in ("\"", "'"):
                in_str2 = c
            elif c == "(" and depth2 == 0:
                open_idx = i
                break
            elif c in "[{":
                depth2 += 1
            elif c in "]}":
                depth2 -= 1
            prev2 = c
        if open_idx < 0 or not part.endswith(")"):
            continue
        name = part[:open_idx].strip()
        args_str = part[open_idx + 1:-1].strip()
        if not name:
            continue
        # Reject prose-y names with colons, equals signs, newlines, etc.
        # A function name is identifier-ish (dots/dashes allowed, single
        # internal spaces allowed for things like "Manufacturing PMI").
        if not re.match(r"^[A-Za-z_][\w.\-]*(?: [A-Za-z_][\w.\-]*)*$", name):
            continue
        args: dict[str, Any] = {}
        if args_str:
            try:
                tree = ast.parse(f"__f({args_str})", mode="eval")
                call = tree.body
                if isinstance(call, ast.Call):
                    pos: list[Any] = []
                    for a in call.args:
                        try:
                            pos.append(ast.literal_eval(a))
                        except (ValueError, SyntaxError):
                            pos.append(ast.unparse(a))
                    if pos:
                        args["_positional"] = pos
                    for kw in call.keywords:
                        if kw.arg is None:
                            continue
                        try:
                            v = ast.literal_eval(kw.value)
                        except (ValueError, SyntaxError):
                            v = ast.unparse(kw.value)
                        args[kw.arg] = v
            except (SyntaxError, ValueError):
                args["_raw"] = args_str
        calls.append({"name": name, "arguments": args})
    return calls


def _extract_tool_calls(
    assistant: dict[str, Any]
) -> list[dict[str, Any]]:
    """Pull tool calls from an assistant turn.

    Recognized formats (in order):
      1. OpenAI ``tool_calls`` array on the raw message.
      2. Hermes ``<tool_call>{...}</tool_call>`` JSON inside content.
      3. APIGen ``[Name(arg=val), ...]`` bracket-call syntax in content.
    """
    raw = assistant.get("raw") or {}
    content = assistant.get("content") or ""

    # OpenAI-format: assistant.tool_calls = [{id,type,function:{name,arguments}}]
    # Some sources (playwright-mcp-toolcalling/train_v4) ship the array
    # as a stringified JSON blob — decode if so.
    raw_calls = raw.get("tool_calls")
    if isinstance(raw_calls, str):
        try:
            raw_calls = json.loads(raw_calls)
        except json.JSONDecodeError:
            raw_calls = []
    parsed: list[dict[str, Any]] = []
    for tc in (raw_calls or []):
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        if not isinstance(fn, dict):
            continue
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                pass
        parsed.append({"name": fn.get("name", ""), "arguments": args or {}})

    # Hermes-style <tool_call>{...}</tool_call>
    if not parsed and "<tool_call>" in content:
        for m in re.finditer(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", content, re.S):
            try:
                obj = json.loads(m.group(1))
                parsed.append({
                    "name": obj.get("name", ""),
                    "arguments": obj.get("arguments") or obj.get("args") or {},
                })
            except json.JSONDecodeError:
                continue

    # APIGen-style [Name(arg=val), Name2(...)]
    if not parsed:
        stripped = content.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            parsed = _parse_apigen_calls(stripped)

    return parsed


_THINK_RE = re.compile(r"<think>([\s\S]*?)</think>\s*", re.M)
_THINKING_RE = re.compile(r"<thinking>([\s\S]*?)</thinking>\s*", re.M)
_THOUGHT_PREFIX_RE = re.compile(
    r"^\s*THOUGHT:\s*([\s\S]*?)(?=\n\s*```|\Z)", re.M
)


def _split_think_response(text: str) -> tuple[str, str]:
    """Return (reasoning, final_response) from a `<think>…</think>\\nfinal`
    blob. If no <think> block is present, reasoning="" and the whole text
    is the response.

    Also recognizes `<thinking>...</thinking>` and the swebench-style
    `THOUGHT: ...` prefix that precedes a fenced
    bash block.
    """
    if not text:
        return "", ""
    m = _THINK_RE.match(text)
    if m:
        return m.group(1).strip(), text[m.end():].strip()
    m = _THINKING_RE.match(text)
    if m:
        return m.group(1).strip(), text[m.end():].strip()
    m = _THOUGHT_PREFIX_RE.match(text)
    if m:
        thought = m.group(1).strip()
        if thought:
            rest = text[m.end():].lstrip("\n")
            # Only treat as a real THOUGHT prefix when followed by a
            # bash/code block — avoids false matches on prose that
            # happens to start with the word "THOUGHT:".
            if rest.startswith("```"):
                return thought, rest.strip()
    return "", text.strip()


def _extract_agent_trove_json_thought(text: str) -> tuple[str, str]:
    """Detect the agent-trove / nemotron-terminal JSON envelope:
    `{"analysis": ..., "plan": ..., "commands": [...], "task_complete": bool}`.

    When matched, return (thought, text) where:
      - thought = analysis + plan (newline-joined)
      - text   = the original JSON unchanged (the model still needs to
                 emit the full structured output for the runtime).

    When the body is not this shape, return ("", text).
    """
    body = text.strip()
    if not (body.startswith("{") and body.endswith("}")):
        return "", text
    try:
        obj = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return "", text
    if not isinstance(obj, dict):
        return "", text
    analysis = obj.get("analysis")
    plan = obj.get("plan")
    parts: list[str] = []
    if isinstance(analysis, str) and analysis.strip():
        parts.append(analysis.strip())
    if isinstance(plan, str) and plan.strip():
        parts.append("Plan: " + plan.strip())
    if not parts:
        return "", text
    return "\n\n".join(parts), text


def _split_thought_and_body(text: str) -> tuple[str, str]:
    """Combine all known reasoning-extraction strategies.

    Returns (thought, body). If nothing matches, returns ("", text.strip()).
    """
    if not text:
        return "", ""
    thought, rest = _split_think_response(text)
    if thought:
        return thought, rest
    # JSON envelope ({analysis, plan, commands}) — keep the original text
    # because the structured payload IS the action the model must emit;
    # we just lift `analysis` + `plan` into `thought` for the planner.
    thought, _ = _extract_agent_trove_json_thought(text)
    if thought:
        return thought, text.strip()
    return "", text.strip()


def _cot_to_expected(
    encoder: ExpectedResponseEncoder,
    raw_text: str,
    *,
    extra_thought: str = "",
) -> str:
    """Wrap a raw chain-of-thought reply as the configured target format.

    Produces `{thought, text}` when a reasoning block can be extracted from
    `<think>` / `<thinking>` / `THOUGHT:` markers in the body,
    OR when `extra_thought` is supplied. Native v5 encodes that object as JSON;
    legacy compatibility rebuilds can still pass a TOON encoder.
    """
    thought, body = _split_thought_and_body(raw_text or "")
    if extra_thought:
        thought = (extra_thought.strip() + ("\n\n" + thought if thought else "")).strip()
    body = _strip_surrogates(body)
    thought = _strip_surrogates(thought)
    if thought:
        return encoder.encode({"thought": thought, "text": body})
    return encoder.encode({"text": body})


# ─────────────────────── canonical planner envelope ─────────────────────────

# Task types whose canonical target IS the full 5-key planner envelope even
# when the assistant turn is a plain free-text reply (PIPELINE_SCHEMAS.md §1).
# `reply` and `reasoning_cot` are intentionally NOT in this set — they map to
# the slim replyTemplate / thinkTemplate forms (`{thought, text}` / `{text}`).
_PLANNER_REPLY_TASK_TYPES = frozenset({
    "agent_trace",
    "mobile_action",
    "shell_command",
    "n8n_workflow_generation",
})


# Pool of thought-phrasings used when the source corpus carries no reasoning
# trace. The previous implementation used a single literal string per action
# class (e.g. `"Reply to the user."`), which trained the model to emit that
# exact string verbatim — surveys of the 7M-record corpus showed 100% of
# Hermes-family records had `"Reply to the user."` as the model's "thought",
# teaching the production model to copy it verbatim instead of reasoning.
#
# We now hash the user message + action name to pick from a phrasing pool, so
# the same upstream record always gets the same thought (deterministic) but
# the corpus distribution is varied. Pools are intentionally short and
# stylistically diverse so no single phrasing dominates.
_REPLY_THOUGHT_POOL = (
    "User asked a direct question; answering.",
    "Drafting a reply.",
    "Composing a response.",
    "Replying with the requested information.",
    "Returning the answer the user expects.",
    "Formulating a reply to the message.",
    "Writing back what the user needs.",
    "Acknowledging and answering.",
    "Producing the requested output.",
    "Engaging with the user's request.",
)
_TOOL_THOUGHT_POOL = (
    "Need a tool to satisfy this — picking the right one.",
    "Routing to a tool call.",
    "Tool needed; selecting the matching one.",
    "Dispatching to a tool.",
    "Invoking the relevant tool.",
    "Calling out to a tool to gather what's needed.",
    "Identifying the required tool.",
    "Function call required for this request.",
    "Reaching for a tool to handle this.",
    "Tool dispatch in order.",
)
_SHELL_THOUGHT_POOL = (
    "Need a shell command to do this.",
    "Running a shell command.",
    "Dispatching a shell call.",
    "Shell command needed for this step.",
    "Executing in the shell.",
    "Reaching for a shell call.",
    "Running this in the terminal.",
    "Shell action is the right move here.",
    "Command needed; running it.",
    "Issuing a terminal command.",
)
_IGNORE_THOUGHT_POOL = (
    "Not addressed to me; staying quiet.",
    "Off-topic for this room — ignoring.",
    "No engagement warranted.",
    "Skipping this turn.",
    "This isn't a request to respond to.",
    "Nothing to act on here.",
    "Holding back — not for me.",
    "Letting this pass.",
    "Not the kind of message I should reply to.",
    "Standing down on this turn.",
)
_AGENT_TRACE_THOUGHT_POOL = (
    "Continuing the running task.",
    "Next step in the trajectory.",
    "Pushing the task forward.",
    "Advancing the active goal.",
    "Handling the next planned step.",
    "Carrying on with the work.",
    "Moving to the next step.",
    "Continuing what was started.",
    "Working through the task.",
    "Proceeding with the agent loop.",
)


def _picked_thought(pool: tuple[str, ...], seed: str) -> str:
    """Pick a phrasing from the pool deterministically based on a content seed.

    Same input → same thought, but the corpus distribution rotates through
    the pool, eliminating the single-string monoculture problem.

    Uses sha256 (NOT Python's `hash()`) because `hash()` is randomized per
    process (PYTHONHASHSEED), which would make the same upstream record
    produce a different thought on every run — defeating the determinism
    contract every downstream tool depends on.
    """
    if not seed:
        return pool[0]
    digest = hashlib.sha256(seed[:256].encode("utf-8", "replace")).digest()
    h = int.from_bytes(digest[:8], "big")
    return pool[h % len(pool)]


# Backward-compatible wrappers — callers pass a seed (typically the user
# message) and get a varied phrasing. Falls back to the first pool entry
# when no seed is provided.
def _DEFAULT_REPLY_THOUGHT_for(seed: str = "") -> str:
    return _picked_thought(_REPLY_THOUGHT_POOL, seed)


def _DEFAULT_TOOL_THOUGHT_for(seed: str = "") -> str:
    return _picked_thought(_TOOL_THOUGHT_POOL, seed)


def _DEFAULT_SHELL_THOUGHT_for(seed: str = "") -> str:
    return _picked_thought(_SHELL_THOUGHT_POOL, seed)


def _DEFAULT_IGNORE_THOUGHT_for(seed: str = "") -> str:
    return _picked_thought(_IGNORE_THOUGHT_POOL, seed)


def _DEFAULT_AGENT_TRACE_THOUGHT_for(seed: str = "") -> str:
    return _picked_thought(_AGENT_TRACE_THOUGHT_POOL, seed)


# Compat aliases — keep the old names so existing call-sites still work,
# but they now resolve to first pool entry. New call-sites should use
# the `_for(seed)` helpers when a content seed is available.
_DEFAULT_REPLY_THOUGHT = _REPLY_THOUGHT_POOL[0]
_DEFAULT_TOOL_THOUGHT = _TOOL_THOUGHT_POOL[0]
_DEFAULT_SHELL_THOUGHT = _SHELL_THOUGHT_POOL[0]
_DEFAULT_IGNORE_THOUGHT = _IGNORE_THOUGHT_POOL[0]
_DEFAULT_AGENT_TRACE_THOUGHT = _AGENT_TRACE_THOUGHT_POOL[0]


def _planner_envelope(
    *,
    thought: str,
    actions: list[Any],
    providers: list[str] | None = None,
    text: str = "",
    simple: bool = True,
    seed: str = "",
) -> dict[str, Any]:
    """Build the canonical 5-key planner envelope dict.

    The runtime parser (`message.ts:5616-5657`) reads exactly these five keys:
    `thought`, `actions`, `providers`, `text`, `simple`. Each `actions[]`
    entry is either a bare uppercase action-name string OR an object
    `{name, params?}`.

    All strings flow through `_strip_surrogates` so the bun encoder accepts
    them. Providers default to an empty list. `simple` defaults to True so
    the planner says "send `text` directly" — callers that want
    action-driven finalization (e.g. when REPLY runs as the action) MUST
    pass `simple=False`.

    `seed` is retained for back-compat but is no longer used to synthesize
    a default thought — when the upstream record carries no real reasoning
    trace, the `thought` field is OMITTED from the envelope entirely. The
    runtime planner parser tolerates a missing `thought:` key, and the
    student model is therefore not trained to emit a placeholder phrase.
    """
    del seed  # back-compat only; default-thought synthesis is removed
    raw_thought = _strip_surrogates(thought or "").strip()
    # Defense in depth: if any upstream caller smuggles in one of the
    # canonical leak literals (or wraps it in quotes), treat it as if no
    # thought was provided and drop the field. The literals are defined
    # once in `lib/eliza_record.DEFAULT_THOUGHT_LEAKS`.
    if is_default_thought_leak(raw_thought):
        raw_thought = ""
    safe_text = _strip_surrogates(text or "")
    safe_actions: list[Any] = []
    for a in actions:
        if isinstance(a, str):
            up = a.strip().upper()
            if up:
                safe_actions.append(up)
            continue
        if isinstance(a, dict):
            name = str(a.get("name", "")).strip().upper()
            if not name:
                continue
            params = a.get("params")
            if isinstance(params, dict) and params:
                safe_actions.append({"name": name, "params": params})
            else:
                safe_actions.append({"name": name})
    safe_providers = [str(p) for p in (providers or []) if isinstance(p, str)]
    envelope: dict[str, Any] = {
        "actions": safe_actions,
        "providers": safe_providers,
        "text": safe_text,
        "simple": bool(simple),
    }
    if raw_thought:
        # Insert at the head so encoded structured targets keep canonical key order.
        envelope = {"thought": raw_thought, **envelope}
    return envelope


def _planner_reply_envelope(
    *, thought: str, text: str, providers: list[str] | None = None,
    seed: str = "",
) -> dict[str, Any]:
    """Planner envelope for a plain REPLY action.

    `simple=true` — the planner's `text` IS the final reply (no need to
    re-run REPLY to generate text).

    If the upstream record carries no real `thought`, the field is omitted
    from the envelope rather than synthesized. The runtime planner parser
    tolerates a missing `thought:` line.
    """
    if is_default_thought_leak(thought):
        thought = ""
    del seed  # retained for back-compat; default-thought synthesis is removed
    return _planner_envelope(
        thought=thought,
        actions=["REPLY"],
        providers=providers or [],
        text=text,
        simple=True,
    )


def _planner_tool_envelope(
    *,
    thought: str,
    tool_calls: list[dict[str, Any]],
    text: str = "",
    providers: list[str] | None = None,
    action_name: str = ACTION_TASKS,
) -> dict[str, Any]:
    """Planner envelope wrapping one or more tool calls.

    Each `tool_calls` entry must be `{name, arguments}`. We emit one
    `actions[]` entry per call with `params: {tool: <name>, arguments:
    <arguments>}`. `simple=false` because actions drive the output.

    Surrogate codepoints in tool names / argument values are stripped so
    the encoder accepts the document.
    """
    actions: list[dict[str, Any]] = []
    for c in tool_calls:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        args = c.get("arguments")
        if not isinstance(args, dict):
            args = {}
        actions.append({
            "name": action_name,
            "params": {
                "tool": _strip_surrogates(name),
                "arguments": args,
            },
        })
    if not actions:
        # Defensive: no callable tool found — fall back to a REPLY envelope
        # so we never emit an empty `actions:` list (which the runtime would
        # treat as the agent doing nothing).
        return _planner_reply_envelope(
            thought=thought,
            text=text or "",
            providers=providers or [],
        )
    if is_default_thought_leak(thought):
        thought = ""
    return _planner_envelope(
        thought=thought,
        actions=actions,
        providers=providers or [],
        text=text or "",
        simple=False,
    )


def _planner_shell_envelope(
    *,
    thought: str,
    command: str,
    explanation: str = "",
    cwd: str = "",
    text: str = "",
    providers: list[str] | None = None,
) -> dict[str, Any]:
    """Planner envelope for a SHELL action.

    The shell-action params surface as `{command, [cwd], [explanation]}`.
    """
    params: dict[str, Any] = {"command": _strip_surrogates(command)}
    if cwd:
        params["cwd"] = _strip_surrogates(cwd)
    if explanation:
        params["explanation"] = _strip_surrogates(explanation)
    if is_default_thought_leak(thought):
        thought = ""
    return _planner_envelope(
        thought=thought,
        actions=[{"name": ACTION_SHELL, "params": params}],
        providers=providers or [],
        text=text or "",
        simple=False,
    )


def _planner_ignore_envelope(
    *, thought: str, text: str = "", seed: str = "",
) -> dict[str, Any]:
    """Planner envelope for an IGNORE decision (no reply, no actions).

    If the upstream record carries no real `thought`, the field is omitted
    from the envelope rather than synthesized.
    """
    if is_default_thought_leak(thought):
        thought = ""
    del seed  # retained for back-compat; default-thought synthesis is removed
    return _planner_envelope(
        thought=thought,
        actions=["IGNORE"],
        providers=[],
        text=text or "",
        simple=True,
    )


def _normalize_tools(tools_raw: Any) -> list[dict[str, Any]]:
    if isinstance(tools_raw, str):
        try:
            tools_raw = json.loads(tools_raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(tools_raw, list):
        return []
    out: list[dict[str, Any]] = []
    for t in tools_raw:
        if not isinstance(t, dict):
            continue
        if "function" in t and isinstance(t["function"], dict):
            fn = t["function"]
            out.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters") or {},
            })
        else:
            out.append({
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "parameters": t.get("parameters") or {},
            })
    return out


def _build_messages_record(
    *, slug: str, license: str, split: str,
    sys_prompt: str, memory: list[dict[str, Any]],
    current: dict[str, Any], assistant: dict[str, Any],
    encoder: ExpectedResponseEncoder,
    tools_list: list[dict[str, Any]] | None = None,
    default_task_type: str = "reply",
    extra_metadata: dict[str, Any] | None = None,
    room_seed: str | None = None,
) -> ElizaRecord:
    """Assemble a flat eliza record from already-split conversation parts."""
    calls = _extract_tool_calls(assistant)
    text = assistant.get("content", "") or ""
    extra_thought = str(assistant.get("_pending_thought") or "")
    thought, body = _split_thought_and_body(text)
    if extra_thought:
        thought = (extra_thought.strip() + ("\n\n" + thought if thought else "")).strip()

    if calls:
        # Tool / MCP call → planner envelope with TASKS action(s).
        # PIPELINE_SCHEMAS.md §1+§5 — every tool_call record is wrapped in the
        # planner 5-key document so the supervised target matches the runtime
        # planner stage exactly.
        task_type = "mcp_tool_call" if default_task_type == "mcp_tool_call" else "tool_call"
        actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
        target = encoder.encode(_planner_tool_envelope(
            thought=thought, tool_calls=calls, text=body, providers=[],
        ))
    elif default_task_type in _PLANNER_REPLY_TASK_TYPES:
        # Free-text reply on a planner-typed task (agent_trace, mobile_action,
        # …) → full planner envelope with REPLY action so the schema audit
        # passes (PIPELINE_SCHEMAS.md §1).
        task_type = default_task_type
        actions = REPLY_ACTIONS.copy()
        target = encoder.encode(_planner_reply_envelope(
            thought=thought, text=body, providers=[],
        ))
    else:
        # `reply` / `reasoning_cot` keep the slim `{thought, text}` /
        # `{text}` form — that is the canonical replyTemplate /
        # thinkTemplate output (PIPELINE_SCHEMAS.md §3-4).
        # If the upstream source defaulted to a tool-call task but this
        # conversation ended on free text, retag as `reply` so the
        # task_type label matches the actual envelope shape.
        if default_task_type in ("tool_call", "mcp_tool_call"):
            task_type = "reply"
        else:
            task_type = default_task_type
        actions = REPLY_ACTIONS.copy()
        target = _cot_to_expected(encoder, text, extra_thought=extra_thought)

    md = {
        "original_id": str(extra_metadata.get("original_id", "") if extra_metadata else ""),
    }
    if sys_prompt:
        md["system_prompt"] = sys_prompt
    if tools_list:
        md["toolSpecs"] = tools_list
    if calls:
        md["expected_tool_calls"] = calls
    if extra_metadata:
        md.update(extra_metadata)

    seed = room_seed or current["content"][:120]
    return build(
        roomName=stable_id(slug, seed),
        agentId="agent",
        memoryEntries=memory,
        currentMessage=current,
        expectedResponse=target,
        availableActions=actions,
        task_type=task_type,
        source_dataset=slug,
        license=license,
        split=split,
        extra_metadata=md,
    )


def _generic_messages(
    records: Iterator[dict], *, slug: str, license: str, split: str,
    messages_key: str | Callable[[dict], list[dict]],
    encoder: ExpectedResponseEncoder,
    default_task_type: str = "reply",
    tools_key: str | None = None,
) -> Iterator[ElizaRecord]:
    """Generic ShareGPT/OpenAI-messages adapter."""
    for r in records:
        msgs = (messages_key(r) if callable(messages_key) else r.get(messages_key)) or []
        # Some sources (toucan, regularizer, nemotron-coding) ship `messages`
        # as a stringified JSON array. JSON-decode and continue.
        if isinstance(msgs, str):
            s = msgs.strip()
            if s.startswith("["):
                try:
                    msgs = json.loads(s)
                except json.JSONDecodeError:
                    continue
            else:
                # Llama-3 chat-template formatted text — skip; we don't
                # currently parse <|start_header_id|> blobs back out.
                continue
        if not msgs:
            continue
        sys_prompt, memory, current, final = _split_history(msgs)
        if not final or not current:
            continue
        tools_list = _normalize_tools(r.get(tools_key)) if tools_key else []
        yield _build_messages_record(
            slug=slug, license=license, split=split,
            sys_prompt=sys_prompt, memory=memory, current=current,
            assistant=final, encoder=encoder, tools_list=tools_list,
            default_task_type=default_task_type,
            extra_metadata={"original_id": str(r.get("id") or "")},
        )


def _decode_message(m: Any) -> dict[str, Any] | None:
    """Decode one message entry into a canonical dict.

    Some sources ship each message as a JSON-stringified blob inside the
    list (e.g. playwright-mcp-toolcalling). Some legitimately ship dicts.
    A bare string falls back to a user turn so we don't lose the row.
    """
    if isinstance(m, str):
        s = m.strip()
        if s.startswith("{"):
            try:
                obj = json.loads(s)
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                pass
        return {"role": "user", "content": m}
    if isinstance(m, dict):
        return m
    return None


def _normalize_messages(msgs: Any) -> list[dict[str, Any]]:
    """Decode every entry in a messages list to a canonical dict."""
    if not isinstance(msgs, list):
        return []
    out: list[dict[str, Any]] = []
    for m in msgs:
        d = _decode_message(m)
        if d is not None:
            out.append(d)
    return out


def _split_per_turn(messages: list[dict[str, Any]]) -> tuple[
    str, list[tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]]
]:
    """Split a multi-turn trace into one supervised record per assistant turn.

    Returns ``(system_prompt, [(memory, current, assistant), ...])`` where
    each tuple is a self-contained training record. ``current`` is the
    most recent user/tool turn before that assistant turn; ``memory`` is
    everything before ``current``.

    Only assistant turns that have content OR tool_calls are emitted.
    """
    system_parts: list[str] = []
    convo: list[dict[str, Any]] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = _norm_role(m.get("role") or m.get("from") or "")
        content = m.get("content") if "content" in m else m.get("value")
        if content is None:
            if role == "assistant" and (m.get("tool_calls") or m.get("function_call")):
                content = ""
            else:
                continue
        if isinstance(content, list):
            content = "".join(
                p.get("text", "") if isinstance(p, dict) else str(p)
                for p in content
            )
        if role == "system":
            system_parts.append(str(content))
            continue
        if role == "reasoning":
            txt = str(content).strip()
            mt = re.match(r"<think>([\s\S]*?)</think>\s*", txt)
            if mt:
                txt = mt.group(1).strip()
            convo.append({"role": "reasoning", "content": txt, "raw": m})
            continue
        entry: dict[str, Any] = {"role": role, "content": str(content), "raw": m}
        if role == "assistant":
            for key in ("reasoning", "thinking", "thought", "reasoning_content"):
                v = m.get(key)
                if isinstance(v, str) and v.strip():
                    entry["_pending_thought"] = v.strip()
                    break
        convo.append(entry)
    # Coalesce reasoning-role messages onto the next assistant turn.
    coalesced: list[dict[str, Any]] = []
    pending_thoughts: list[str] = []
    for m in convo:
        if m["role"] == "reasoning":
            if m["content"]:
                pending_thoughts.append(m["content"])
            continue
        if m["role"] == "assistant" and pending_thoughts:
            existing = m.get("_pending_thought") or ""
            joined = "\n\n".join([t for t in [existing, *pending_thoughts] if t]).strip()
            m = {**m, "_pending_thought": joined}
            pending_thoughts = []
        coalesced.append(m)
    convo = coalesced

    sys_prompt = "\n\n".join(system_parts)
    out: list[tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]] = []
    for i, m in enumerate(convo):
        if m["role"] != "assistant":
            continue
        # Need a meaningful assistant turn: content (after strip) or
        # tool_calls. ``tool_calls`` may legitimately be ``null`` on
        # decoded JSON-message rows, so coerce explicitly.
        raw_calls = m["raw"].get("tool_calls")
        raw_fc = m["raw"].get("function_call")
        has_calls = bool(raw_calls) or bool(raw_fc)
        content_stripped = (m["content"] or "").strip()
        if not content_stripped and not has_calls:
            continue
        # Find the most recent user (preferred) or tool turn before this
        # assistant — that becomes ``current``. If neither exists, skip.
        current_idx = -1
        for j in range(i - 1, -1, -1):
            if convo[j]["role"] in ("user", "tool"):
                current_idx = j
                break
        if current_idx < 0:
            continue
        cur = convo[current_idx]
        current = {
            "role": cur["role"],
            "speaker": cur["role"],
            "content": cur["content"],
            "channel": "dm",
        }
        memory = [
            {
                "role": cm["role"],
                "speaker": cm["role"],
                "content": cm["content"],
                "channel": "dm",
            }
            for cm in convo[:current_idx]
        ]
        out.append((memory, current, m))
    return sys_prompt, out


# ─────────────────────────── per-format adapters ────────────────────────────

_SCAM_DECISION_TO_ELIZA_ACTION = {
    # IGNORE-class decisions
    "ignore": "IGNORE",
    "block": "IGNORE",
    "decline": "IGNORE",
    "decline_to_answer": "IGNORE",
    "refuse": "IGNORE",
    # REPLY-class decisions
    "reply": "REPLY",
    "respond": "REPLY",
    "engage": "REPLY",
    "accept": "REPLY",
    "audit": "REPLY",
    "request-verification": "REPLY",
    "request_verification": "REPLY",
    "verify": "REPLY",
    "escalate": "REPLY",
    "ask": "REPLY",
    "clarify": "REPLY",
}


def _normalize_scam_actions(actions: list) -> list[str]:
    """Map scambench/scam-defense lowercase decision names to canonical
    eliza action names (REPLY / IGNORE). Anything unrecognized passes
    through uppercased so we don't silently drop unknown actions."""
    out: list[str] = []
    seen: set[str] = set()
    for a in actions or []:
        key = str(a).strip().lower().replace("-", "_")
        canonical = _SCAM_DECISION_TO_ELIZA_ACTION.get(key, str(a).strip().upper())
        if canonical and canonical not in seen:
            seen.add(canonical)
            out.append(canonical)
    if not out:
        out = ["REPLY", "IGNORE"]
    return out


def scambench_passthrough(records, *, slug, license, split, encoder):
    """ScamBench `eliza` config — emit canonical planner envelope so
    `task_type=scam_defense` records share the planner schema with the rest
    of the corpus (PIPELINE_SCHEMAS.md §9). The decision class maps to either
    REPLY (engage / verify / decline) or IGNORE (block, ignore)."""
    for r in records:
        meta = r.get("metadata") or {}
        decision = (meta.get("decision_class") or "").strip().lower()
        reasoning = (meta.get("reasoning_trace") or "").strip()
        text = r.get("expectedResponse", "") or ""
        if decision in ("ignore", "block", "decline_to_answer", "decline", "refuse"):
            target = _planner_ignore_envelope(
                thought=reasoning,
                text=text,
                seed=text,
            )
        else:
            target = _planner_reply_envelope(
                thought=reasoning,
                text=text, providers=[],
                seed=text,
            )
        expected_response = encoder.encode(target)
        yield build(
            roomName=r.get("roomName", "") or stable_id(slug, r.get("currentMessage", {}).get("content", "")),
            agentId=r.get("agentId", "scam-defense-agent"),
            memoryEntries=r.get("memoryEntries") or [],
            currentMessage=r.get("currentMessage") or {},
            expectedResponse=expected_response,
            availableActions=_normalize_scam_actions(
                r.get("availableActions") or []
            ),
            task_type="scam_defense",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={
                "language": meta.get("language", ""),
                "scenario_category": meta.get("scenario_category", ""),
                "decision_class": meta.get("decision_class", ""),
                "should_trigger_scam_defense": meta.get("should_trigger_scam_defense"),
                "reasoning_trace": meta.get("reasoning_trace"),
            },
        )


def hermes_fc(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key="conversations", encoder=encoder,
        default_task_type="tool_call", tools_key="tools")


def hermes_fc_thinking(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key="conversations", encoder=encoder,
        default_task_type="tool_call", tools_key="tools")


def glaive_fc(records, *, slug, license, split, encoder):
    """Glaive function-calling v2 — `chat` is a single string with role markers.

    The `-reasoning` shard ships an extra `processed_chat_with_reasoning`
    field where each ASSISTANT turn is prefixed with `<think>...</think>`;
    we prefer it when present so `_cot_to_expected` can lift the reasoning
    into `thought:` instead of dropping it.
    """
    for r in records:
        if isinstance(r.get("messages"), list):
            yield from _generic_messages(iter([r]), slug=slug, license=license, split=split,
                messages_key="messages", encoder=encoder,
                default_task_type="tool_call", tools_key="tools")
            continue
        chat = r.get("processed_chat_with_reasoning") or r.get("chat") or ""
        sys_prompt = r.get("system") or ""
        parts = re.split(r"(USER:|ASSISTANT:|FUNCTION RESPONSE:|SYSTEM:|A:|FUNCTION CALL:|FUNCTION RESULT:)", chat)
        msgs: list[dict[str, Any]] = []
        i = 1
        while i < len(parts) - 1:
            marker, content = parts[i], parts[i + 1].strip()
            role = {
                "USER:": "user", "ASSISTANT:": "assistant", "A:": "assistant",
                "FUNCTION RESPONSE:": "tool", "FUNCTION RESULT:": "tool",
                "FUNCTION CALL:": "assistant",
                "SYSTEM:": "system",
            }.get(marker, "user")
            msgs.append({"role": role, "content": content})
            i += 2
        if sys_prompt:
            msgs.insert(0, {"role": "system", "content": sys_prompt})
        if not msgs:
            continue
        yield from _generic_messages(iter([{"messages": msgs, "tools": r.get("tools")}]),
            slug=slug, license=license, split=split,
            messages_key="messages", encoder=encoder,
            default_task_type="tool_call", tools_key="tools")


def glaive_fc_reasoning(records, *, slug, license, split, encoder):
    return glaive_fc(records, slug=slug, license=license, split=split, encoder=encoder)


def sharegpt_tool_calls(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key="conversations", encoder=encoder,
        default_task_type="tool_call", tools_key="tools")


def functions_53k(records, *, slug, license, split, encoder):
    for r in records:
        if isinstance(r.get("messages"), list):
            yield from _generic_messages(iter([r]), slug=slug, license=license, split=split,
                messages_key="messages", encoder=encoder,
                default_task_type="tool_call", tools_key="functions")
            continue
        prompt = r.get("prompt") or r.get("input") or ""
        completion = r.get("completion") or r.get("output") or ""
        if not prompt or not completion:
            continue
        calls: list[dict[str, Any]] = []
        try:
            parsed = json.loads(completion) if isinstance(completion, str) else completion
            if isinstance(parsed, dict) and "name" in parsed:
                calls = [{"name": parsed["name"], "arguments": parsed.get("arguments") or {}}]
            elif isinstance(parsed, list):
                calls = [{"name": p.get("name", ""), "arguments": p.get("arguments") or {}}
                         for p in parsed if isinstance(p, dict)]
        except (json.JSONDecodeError, TypeError):
            pass
        if calls:
            target = encoder.encode(_planner_tool_envelope(
                thought="", tool_calls=calls, providers=[],
            ))
            actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
            tt = "tool_call"
        else:
            target = _cot_to_expected(encoder, str(completion))
            actions = REPLY_ACTIONS.copy()
            tt = "reply"
        yield build(
            roomName=stable_id(slug, r.get("id") or prompt[:120]),
            agentId="agent",
            currentMessage={"role": "user", "speaker": "user", "content": prompt, "channel": "dm"},
            memoryEntries=[],
            expectedResponse=target,
            availableActions=actions,
            task_type=tt,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={
                "original_id": str(r.get("id") or ""),
                "toolSpecs": _normalize_tools(r.get("functions")),
                "expected_tool_calls": calls,
            },
        )


def bitagent(records, *, slug, license, split, encoder):
    """BitAgent/tool_calling — `conversation` and `tools` are stringified JSON.
    Roles include 'tool call' and 'tool response' (with content sometimes a dict)."""
    def _normalize(r: dict) -> dict:
        conv = r.get("conversation") or r.get("conversations") or []
        if isinstance(conv, str):
            try:
                conv = json.loads(conv)
            except json.JSONDecodeError:
                conv = []
        # Map "tool call" / "tool response" roles, and dict-content tool calls.
        normalized: list[dict] = []
        for m in conv if isinstance(conv, list) else []:
            if not isinstance(m, dict):
                continue
            role = m.get("role", "")
            content = m.get("content")
            if role == "tool call" and isinstance(content, dict):
                # render as Hermes <tool_call> for _extract_tool_calls
                normalized.append({
                    "role": "assistant",
                    "content": "<tool_call>" + json.dumps(content) + "</tool_call>",
                })
            elif role in ("tool response", "tool"):
                normalized.append({"role": "tool", "content": str(content)})
            else:
                normalized.append({"role": role, "content": str(content) if content is not None else ""})
        return {"messages": normalized, "tools": r.get("tools")}

    yield from _generic_messages(
        (_normalize(r) for r in records),
        slug=slug, license=license, split=split,
        messages_key="messages", encoder=encoder,
        default_task_type="tool_call", tools_key="tools",
    )


def toolhop(records, *, slug, license, split, encoder):
    """ToolHop — single Q/A with a list of tool functions. We don't have the
    multi-step trace, so we materialize one record per Q with the answer as a
    plain reasoning_cot target (the model picks the right tool internally)."""
    for r in records:
        question = r.get("question") or r.get("query") or ""
        answer = str(r.get("answer") or "")
        if not question or not answer:
            continue
        tools_raw = r.get("functions") or r.get("tools") or []
        tools_list = _normalize_tools(tools_raw)
        yield build(
            roomName=stable_id(slug, str(r.get("id") or question[:120])),
            agentId="agent",
            currentMessage={"role": "user", "speaker": "user", "content": question, "channel": "dm"},
            memoryEntries=[],
            expectedResponse=_cot_to_expected(encoder, answer),
            availableActions=[ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE],
            task_type="reasoning_cot",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={
                "original_id": str(r.get("id") or ""),
                "toolSpecs": tools_list,
                "domain": str(r.get("domain") or ""),
                "answer_type": str(r.get("answer_type") or ""),
            },
        )


def openclaw_operator(records, *, slug, license, split, encoder):
    """CyberAGI/openclaw-operator-data — actually OpenAI-style messages
    `{messages: [...]}` with assistant turns sometimes containing
    JSON-encoded tool-call lists. Route through generic messages and let
    _extract_tool_calls do its job."""
    yield from _generic_messages(
        records, slug=slug, license=license, split=split,
        messages_key="messages", encoder=encoder,
        default_task_type="agent_trace", tools_key="tools",
    )


def mobile_actions(records, *, slug, license, split, encoder):
    """google/mobile-actions — `{metadata, tools, messages}`. The assistant
    turn embeds the tool call as a JSON list under content; _extract_tool_calls
    handles the OpenAI-style tool_calls field too. Treat as tool_call task
    but tag task_type=mobile_action via metadata so the manifest separates
    mobile from server-side tool calls."""
    def _retag(records_iter):
        for r in records_iter:
            yield {
                "messages": r.get("messages") or [],
                "tools": r.get("tools") or [],
                "_mobile_metadata": r.get("metadata"),
            }
    yield from _generic_messages(
        _retag(records), slug=slug, license=license, split=split,
        messages_key="messages", encoder=encoder,
        default_task_type="tool_call", tools_key="tools",
    )


def nemotron_rl_tool_use(records, *, slug, license, split, encoder):
    """nvidia/Nemotron-RL-Agentic-Conversational-Tool-Use-Pivot-v1 — the
    conversation lives under `responses_create_params.input`; tools live
    under `responses_create_params.tools`; the supervised target is the
    `expected_action` JSON dict."""
    def _normalize(r: dict) -> dict:
        rcp = r.get("responses_create_params") or {}
        msgs = rcp.get("input") or []
        tools = rcp.get("tools") or []
        # Append the expected_action as the assistant's tool call so
        # _extract_tool_calls can lift it out the standard way.
        ea = r.get("expected_action") or {}
        if isinstance(ea, dict) and ea.get("name"):
            msgs = list(msgs) + [{
                "role": "assistant",
                "content": "<tool_call>" + json.dumps({
                    "name": ea.get("name", ""),
                    "arguments": ea.get("arguments") or ea.get("args") or {},
                }) + "</tool_call>",
            }]
        return {"messages": msgs, "tools": tools, "id": r.get("trajectory_id")}

    yield from _generic_messages(
        (_normalize(r) for r in records),
        slug=slug, license=license, split=split,
        messages_key="messages", encoder=encoder,
        default_task_type="tool_call", tools_key="tools",
    )


def qwen36_trajectory(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key=lambda r: r.get("messages") or r.get("conversations") or r.get("trajectory") or [],
        encoder=encoder, default_task_type="agent_trace", tools_key="tools")


def hermes_reasoning_tool_use(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key=lambda r: r.get("conversations") or r.get("messages") or [],
        encoder=encoder, default_task_type="tool_call", tools_key="tools")


def dolci_instruct(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key=lambda r: r.get("messages") or r.get("conversations") or [],
        encoder=encoder, default_task_type="tool_call", tools_key="tools")


def hermes_traces(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key=lambda r: r.get("conversations") or r.get("messages") or r.get("trajectory") or [],
        encoder=encoder, default_task_type="agent_trace", tools_key="tools")


def hermes_omniforge(records, *, slug, license, split, encoder):
    return hermes_traces(records, slug=slug, license=license, split=split, encoder=encoder)


def hermes_3(records, *, slug, license, split, encoder):
    return _generic_messages(records, slug=slug, license=license, split=split,
        messages_key=lambda r: r.get("conversations") or r.get("messages") or [],
        encoder=encoder, default_task_type="agent_trace", tools_key="tools")


def aureth(records, *, slug, license, split, encoder):
    return hermes_traces(records, slug=slug, license=license, split=split, encoder=encoder)


def nemotron_coding_reasoning(records, *, slug, license, split, encoder):
    return hermes_traces(records, slug=slug, license=license, split=split, encoder=encoder)


def hf_coding_tools_traces(records, *, slug, license, split, encoder):
    return hermes_traces(records, slug=slug, license=license, split=split, encoder=encoder)


_CHATML_RE = re.compile(
    r"<\|im_start\|>\s*(\w+)\s*\n(.*?)<\|im_end\|>",
    re.DOTALL,
)


def _parse_chatml(text: str) -> list[dict[str, str]]:
    """Parse Qwen/ChatML <|im_start|>role\\n...<|im_end|> blocks into messages."""
    msgs: list[dict[str, str]] = []
    for m in _CHATML_RE.finditer(text):
        role = (m.group(1) or "").strip().lower()
        content = (m.group(2) or "").strip()
        if not role:
            continue
        msgs.append({"role": role, "content": content})
    return msgs


def chatml_text(records, *, slug, license, split, encoder):
    """Single `text` field containing a Qwen ChatML conversation."""
    for r in records:
        text = r.get("text") or ""
        if not isinstance(text, str) or "<|im_start|>" not in text:
            continue
        msgs = _parse_chatml(text)
        if not msgs:
            continue
        yield from _generic_messages(
            iter([{"messages": msgs}]),
            slug=slug, license=license, split=split,
            messages_key="messages", encoder=encoder,
            default_task_type="reasoning_cot",
        )


_GEMMA_RE = re.compile(
    r"<start_of_turn>\s*(\w+)\s*(.*?)<end_of_turn>",
    re.DOTALL,
)

# Home-Assistant MCP DSL inside Gemma chat templates:
#   <start_function_call>call:NAME{key:<escape>val<escape>,key:val}<end_function_call>
_HA_FUNC_CALL_RE = re.compile(
    r"<start_function_call>\s*call:([A-Za-z_][\w]*)\s*\{(.*?)\}\s*<end_function_call>",
    re.S,
)
_HA_THINK_RE = re.compile(r"<think>(.*?)</think>", re.S)
_HA_ESCAPE = "<escape>"


def _parse_ha_mcp_args(body: str) -> dict[str, Any]:
    """Parse a HA-MCP DSL argument body into a dict.

    Body shape: ``key:<escape>str<escape>,key:42,nested:{...}``. Strings
    are wrapped in ``<escape>...<escape>``; bare integers/floats appear
    unwrapped.
    """
    args: dict[str, Any] = {}
    depth = 0
    in_escape = False
    starts = [0]
    i = 0
    while i < len(body):
        if not in_escape and body.startswith(_HA_ESCAPE, i):
            in_escape = True
            i += len(_HA_ESCAPE)
            continue
        if in_escape and body.startswith(_HA_ESCAPE, i):
            in_escape = False
            i += len(_HA_ESCAPE)
            continue
        c = body[i]
        if not in_escape:
            if c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
            elif c == "," and depth == 0:
                starts.append(i + 1)
        i += 1
    parts: list[str] = []
    for j, s in enumerate(starts):
        e = starts[j + 1] - 1 if j + 1 < len(starts) else len(body)
        parts.append(body[s:e])
    for p in parts:
        p = p.strip()
        if not p:
            continue
        colon = p.find(":")
        if colon < 0:
            continue
        k = p[:colon].strip()
        v = p[colon + 1:].strip()
        if v.startswith(_HA_ESCAPE) and v.endswith(_HA_ESCAPE):
            args[k] = v[len(_HA_ESCAPE):-len(_HA_ESCAPE)]
        else:
            try:
                args[k] = int(v) if "." not in v else float(v)
            except ValueError:
                args[k] = v
    return args


def _extract_ha_mcp_calls(content: str) -> tuple[list[dict[str, Any]], str, str]:
    """Pull HA-MCP DSL function calls out of an assistant turn.

    Returns ``(tool_calls, thought, trailing_text)``. ``thought`` is the
    ``<think>...</think>`` block (if any). ``trailing_text`` is the
    user-facing reply that follows the ``<end_function_response>`` block,
    if present.
    """
    calls: list[dict[str, Any]] = []
    for m in _HA_FUNC_CALL_RE.finditer(content):
        calls.append({
            "name": m.group(1),
            "arguments": _parse_ha_mcp_args(m.group(2)),
        })
    thought = ""
    tm = _HA_THINK_RE.search(content)
    if tm:
        thought = tm.group(1).strip()
    trailing = ""
    end_tag = content.rfind("<end_function_response>")
    if end_tag >= 0:
        trailing = content[end_tag + len("<end_function_response>"):].strip()
    return calls, thought, trailing


_HA_FUNC_RESP_RE = re.compile(
    r"<start_function_response>(.*?)<end_function_response>",
    re.S,
)


def _expand_ha_assistant(content: str) -> list[dict[str, Any]]:
    """Split an HA-MCP assistant turn into ``[assistant_call, tool, assistant_reply]``.

    The HA-MCP single-turn assistant string interleaves a ``<think>`` block,
    one ``<start_function_call>...<end_function_call>``, one
    ``<start_function_response>...<end_function_response>``, and a final
    user-facing reply. Splitting these into three logical messages lets the
    multi-turn record splitter treat the call and the reply as separate
    supervised targets.
    """
    if "<start_function_call>" not in content:
        # Plain assistant reply (HA-MCP also has these — "I'm a smart home
        # assistant and can't make phone calls.").
        return [{"role": "assistant", "content": content}]
    calls, thought, trailing = _extract_ha_mcp_calls(content)
    out: list[dict[str, Any]] = []
    if calls:
        msg: dict[str, Any] = {"role": "assistant", "content": ""}
        if thought:
            msg["content"] = f"<think>{thought}</think>"
        msg["tool_calls"] = [
            {
                "id": f"call_{i}",
                "type": "function",
                "function": {
                    "name": c["name"],
                    "arguments": json.dumps(c["arguments"]),
                },
            }
            for i, c in enumerate(calls)
        ]
        out.append(msg)
    rm = _HA_FUNC_RESP_RE.search(content)
    if rm:
        out.append({"role": "tool", "content": rm.group(1).strip()})
    if trailing:
        out.append({"role": "assistant", "content": trailing})
    return out


def _parse_gemma(text: str) -> list[dict[str, Any]]:
    """Parse Gemma-style ``<start_of_turn>role ...<end_of_turn>`` into messages.

    Assistant turns that embed the HA-MCP ``<start_function_call>`` DSL
    are split into ``[assistant_call, tool_response, assistant_reply]`` so
    each step is a separate supervised target.
    """
    msgs: list[dict[str, Any]] = []
    for m in _GEMMA_RE.finditer(text):
        role = (m.group(1) or "").strip().lower()
        content = (m.group(2) or "").strip()
        if not role or not content:
            continue
        if role in ("model", "assistant"):
            msgs.extend(_expand_ha_assistant(content))
        else:
            msgs.append({"role": role, "content": content})
    return msgs


def gemma_text(records, *, slug, license, split, encoder):
    """Single ``text`` field with a Gemma chat-template conversation.

    For HA-MCP records, the assistant's DSL function call is hoisted into
    OpenAI ``tool_calls`` so the standard tool-call pipeline encodes
    it as ``{tool_calls[N]{name,arguments}: ...}``.
    """
    for r in records:
        text = r.get("text") or ""
        if not isinstance(text, str) or "<start_of_turn>" not in text:
            continue
        msgs = _parse_gemma(text)
        if not msgs:
            continue
        # Use the multi-turn splitter so each assistant turn (call AND
        # final reply) becomes a supervised record. For HA-MCP this means
        # both the tool call and the trailing user-facing confirmation
        # become training rows. Pure-reply records (no DSL call) still
        # produce one row per assistant turn.
        yield from _mcp_multi_turn(
            {"id": r.get("id") or "", "tools": []},
            msgs,
            slug=slug, license=license, split=split, encoder=encoder,
        )


# ─────────────────────── Llama-3 chat template ──────────────────────────────

# Matches one role-block in a Llama-3 chat template:
#   <|start_header_id|>ROLE<|end_header_id|>\nCONTENT<|eot_id|>   (turn end)
#   <|start_header_id|>ROLE<|end_header_id|>\nCONTENT<|eom_id|>   (message end, more from same role)
_LLAMA3_RE = re.compile(
    r"<\|start_header_id\|>\s*(\w+)\s*<\|end_header_id\|>\s*(.*?)(?=<\|eot_id\|>|<\|eom_id\|>|<\|start_header_id\|>|\Z)",
    re.DOTALL,
)

_LLAMA3_PYTHON_TAG_RE = re.compile(r"<\|python_tag\|>(.*?)\Z", re.DOTALL)
_LLAMA3_FUNC_CALL_RE = re.compile(r"^\s*([a-zA-Z_][\w\.\-]*)\s*\((.*)\)\s*$", re.DOTALL)


def _parse_llama3_tool_call(call: str) -> dict[str, Any] | None:
    """Parse a single Llama-3 pythonic tool call: `func_name({json_args})`.

    Returns `{"name": ..., "arguments": ...}` or None on unparseable inputs.
    Falls back to `{"raw": <args_str>}` arguments when the args region looks
    like JSON but contains unescaped quotes (e.g. GraphQL queries embedded
    in the string)."""
    call = call.strip()
    if not call:
        return None
    m = _LLAMA3_FUNC_CALL_RE.match(call)
    if not m:
        return None
    name = m.group(1)
    args_str = m.group(2).strip()
    if not args_str:
        return {"name": name, "arguments": {}}
    try:
        args = json.loads(args_str)
        if not isinstance(args, dict):
            args = {"value": args}
    except json.JSONDecodeError:
        # Unescaped quotes inside JSON strings (common when the args are
        # GraphQL-like queries). Preserve the raw payload so we don't drop
        # the row.
        args = {"raw": args_str}
    return {"name": name, "arguments": args}


def _parse_llama3_chat(text: str) -> list[dict[str, Any]]:
    """Parse Llama-3 `<|start_header_id|>ROLE<|end_header_id|>...` blocks.

    Each match becomes one message. Tool calls embedded as `<|python_tag|>`
    in an assistant block are surfaced via `tool_calls` so
    `_extract_tool_calls` picks them up. The Llama tool role
    (`ipython`) maps to canonical `tool` via ROLE_MAP.
    """
    msgs: list[dict[str, Any]] = []
    for m in _LLAMA3_RE.finditer(text):
        role = (m.group(1) or "").strip().lower()
        content = (m.group(2) or "").strip()
        if not role:
            continue
        msg: dict[str, Any] = {"role": role, "content": content}
        # Pull any tool call out of the assistant content into tool_calls so
        # _extract_tool_calls finds it (OpenAI-style path).
        if role == "assistant" and "<|python_tag|>" in content:
            head, _, tail = content.partition("<|python_tag|>")
            tool_calls: list[dict[str, Any]] = []
            for raw_call in tail.split("<|python_tag|>"):
                parsed = _parse_llama3_tool_call(raw_call)
                if parsed:
                    tool_calls.append({
                        "type": "function",
                        "function": {
                            "name": parsed["name"],
                            "arguments": json.dumps(parsed["arguments"]),
                        },
                    })
            if tool_calls:
                msg["content"] = head.strip()
                msg["tool_calls"] = tool_calls
        msgs.append(msg)
    return msgs


# ─────────────────── NOESIS plain-text User:/Assistant: ────────────────────

# Match a role marker at line start: `User:` / `Assistant:` / `System:`.
_NOESIS_ROLE_RE = re.compile(r"(?:^|\n)(User|Assistant|System|Human):", re.MULTILINE)


def _parse_noesis_text(text: str) -> list[dict[str, str]]:
    """Split a NOESIS `text` payload into role/content turns.

    Format: `User: <q>\\nAssistant: <a>` (optional multi-turn). The blob is
    a flat dump with no other delimiters, so we anchor on `\\n(User|Assistant
    |System):` line starts and slice between matches.
    """
    matches = list(_NOESIS_ROLE_RE.finditer(text))
    if not matches:
        return []
    msgs: list[dict[str, str]] = []
    for i, m in enumerate(matches):
        role_raw = m.group(1).lower()
        role = "user" if role_raw in ("user", "human") else (
            "assistant" if role_raw == "assistant" else "system"
        )
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        content = text[start:end].strip()
        if not content:
            continue
        msgs.append({"role": role, "content": content})
    return msgs


# Sentence-end heuristic for filtering NOESIS truncated records. The dataset
# is hard-truncated at `tok_len` tokens; a clean record ends on punctuation,
# a closing bracket/quote/code fence, or a `\boxed{...}` math marker.
_NOESIS_CLEAN_END = re.compile(
    r"(?:[.!?。！？\)\]\}»」』]|`{3}|\\boxed\{[^}]+\}|\*\*\.)\s*$"
)


def noesis_text(records, *, slug, license, split, encoder):
    """AMAImedia/NOESIS-1M — `{text, domain, src, tok_len}` rows where `text`
    is a flat `User: ...\\nAssistant: ...` dump.

    Skips rows that are user-only (the dataset truncates at `tok_len`, so
    many reasoning/code rows have no assistant turn) or whose final
    assistant turn ends mid-word (truncated supervision target). Multi-turn
    rows go through the generic messages path and naturally pick the last
    assistant turn as the supervised target. CoT rows (with `<think>`
    blocks or in a reasoning/code/math domain) are tagged `reasoning_cot`
    so the assistant text passes through as plain text rather than
    structured reply.
    """
    for r in records:
        text = r.get("text") or ""
        if not isinstance(text, str) or "User:" not in text:
            continue
        msgs = _parse_noesis_text(text)
        if not msgs:
            continue
        # Need at least one assistant turn for supervision.
        last_asst = None
        for m in reversed(msgs):
            if m["role"] == "assistant":
                last_asst = m
                break
        if last_asst is None:
            continue
        # Drop truncated assistant turns: target must end on a sentence
        # boundary, closing bracket/quote, `\boxed{...}`, or markdown bold.
        asst_text = last_asst["content"].rstrip()
        if not asst_text or not _NOESIS_CLEAN_END.search(asst_text):
            continue
        domain = r.get("domain") or ""
        is_reasoning = (
            "<think>" in text or domain in ("reasoning", "code", "math", "science", "stem")
        )
        default_tt = "reasoning_cot" if is_reasoning else "reply"
        yield from _generic_messages(
            iter([{"messages": msgs}]),
            slug=slug, license=license, split=split,
            messages_key="messages", encoder=encoder,
            default_task_type=default_tt,
        )


def open_paws_llama(records, *, slug, license, split, encoder):
    """open-paws/tool-use-llama-format — `messages` is a Llama-3 chat-template
    string. Parse role blocks, surface `<|python_tag|>` tool calls as OpenAI
    `tool_calls`, then route through the generic messages path so the final
    assistant turn becomes either a `tool_call` (structured `tool_calls`) or a
    `reply` (structured `thought`/`text`)."""
    for r in records:
        text = r.get("messages")
        if not isinstance(text, str) or "<|start_header_id|>" not in text:
            continue
        msgs = _parse_llama3_chat(text)
        if not msgs:
            continue
        yield from _generic_messages(
            iter([{"messages": msgs}]),
            slug=slug, license=license, split=split,
            messages_key="messages", encoder=encoder,
            default_task_type="reply",
        )


# ───────────────────────────── MCP family ───────────────────────────────────

# phi3-mcp DSL: ``TOOL_NEEDED: <name>\nPARAMS: <json>\nREASON: <text>``
_PHI3_TOOL_RE = re.compile(r"TOOL_NEEDED:\s*([^\n]+)", re.S)
_PHI3_PARAMS_RE = re.compile(r"PARAMS:\s*(\{.*?\})\s*(?:\nREASON:|\Z)", re.S)
_PHI3_REASON_RE = re.compile(r"REASON:\s*(.+)\Z", re.S)


def _parse_phi3_output(text: str) -> tuple[dict[str, Any] | None, str]:
    """Parse a phi3-mcp ``output`` string into ``(tool_call_or_None, reason)``."""
    if not text:
        return None, ""
    if "TOOL_NEEDED:" not in text:
        return None, text.strip()
    name_m = _PHI3_TOOL_RE.search(text)
    params_m = _PHI3_PARAMS_RE.search(text)
    reason_m = _PHI3_REASON_RE.search(text)
    if not name_m:
        return None, text.strip()
    name = name_m.group(1).strip()
    args: dict[str, Any] = {}
    if params_m:
        try:
            parsed = json.loads(params_m.group(1))
            if isinstance(parsed, dict):
                args = parsed
        except json.JSONDecodeError:
            args = {"_raw": params_m.group(1)}
    reason = reason_m.group(1).strip() if reason_m else ""
    return {"name": name, "arguments": args}, reason


def mcp_messages(records, *, slug, license, split, encoder):
    """Generic MCP-style records.

    Three shapes are supported:

    1. **Multi-turn message lists** (``messages``/``conversations``/...)
       are split into one supervised record per assistant turn. Each
       assistant turn lands as structured ``tool_calls`` when it carries any
       tool call (OpenAI ``tool_calls``, Hermes ``<tool_call>``, or
       APIGen ``[Func(...)]``). Otherwise it lands as structured output
       ``{thought, text}`` for text replies. This recovers tool calls
       that live in the middle of agent traces (deepfabric-github-mcp,
       playwright-mcp-toolcalling) instead of dropping them in favor of
       the final text turn.

    2. **Alpaca with phi3-mcp DSL** (``instruction``/``input``/``output``
       where ``output`` is ``TOOL_NEEDED: <name>\\nPARAMS: <json>``).
       Tool calls land as structured ``tool_calls`` with the reason in
       ``metadata.tool_reason``; non-tool replies land as structured output
       ``{thought, text}``.

    3. **Generic Alpaca** (``instruction``/``input``/``output``). The
       output is checked for embedded APIGen / Hermes tool calls and
       routed to structured ``tool_calls`` when present.
    """
    for r in records:
        msgs = (
            r.get("messages") or r.get("conversations")
            or r.get("chat") or r.get("trajectory") or []
        )
        if msgs:
            yield from _mcp_multi_turn(
                r, msgs, slug=slug, license=license, split=split,
                encoder=encoder,
            )
            continue

        instruction = r.get("instruction") or ""
        user_input = r.get("input") or ""
        output = r.get("output") or r.get("response") or r.get("completion") or ""
        if not output:
            continue
        prompt_parts = [p for p in (instruction, user_input) if p]
        if not prompt_parts:
            continue
        prompt = "\n\n".join(str(p) for p in prompt_parts)

        # phi3-mcp DSL.
        call, reason = _parse_phi3_output(str(output))
        if call is not None:
            target = encoder.encode(_planner_tool_envelope(
                thought=reason,
                tool_calls=[call], providers=[],
            ))
            actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
            tt = "tool_call"
            md: dict[str, Any] = {
                "original_id": str(r.get("id") or ""),
                "expected_tool_calls": [call],
            }
            if reason:
                md["tool_reason"] = reason
            yield build(
                roomName=stable_id(slug, prompt[:120]),
                agentId="mcp-agent",
                currentMessage={"role": "user", "speaker": "user", "content": prompt, "channel": "dm"},
                memoryEntries=[],
                expectedResponse=target,
                availableActions=actions,
                task_type=tt,
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata=md,
            )
            continue

        # Generic alpaca: probe for embedded tool-call syntaxes.
        fake_assistant = {"raw": {}, "content": str(output)}
        calls = _extract_tool_calls(fake_assistant)
        if calls:
            target = encoder.encode(_planner_tool_envelope(
                thought="", tool_calls=calls, providers=[],
            ))
            actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
            tt = "tool_call"
            md = {
                "original_id": str(r.get("id") or ""),
                "expected_tool_calls": calls,
            }
        else:
            # Plain reply — drop the thought line when there's no upstream
            # reasoning to attach (avoids training the model to emit
            # `thought: ""`). When the body has <think>...</think> the
            # _cot_to_expected helper extracts it automatically.
            target = _cot_to_expected(encoder, str(output))
            actions = REPLY_ACTIONS.copy()
            tt = "reply"
            md = {"original_id": str(r.get("id") or "")}
        yield build(
            roomName=stable_id(slug, prompt[:120]),
            agentId="mcp-agent",
            currentMessage={"role": "user", "speaker": "user", "content": prompt, "channel": "dm"},
            memoryEntries=[],
            expectedResponse=target,
            availableActions=actions,
            task_type=tt,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )


def _mcp_multi_turn(
    r: dict[str, Any], msgs_raw: Any, *, slug: str, license: str, split: str,
    encoder: ExpectedResponseEncoder,
) -> Iterator[ElizaRecord]:
    """Emit one supervised record per assistant turn in a messages list."""
    msgs = _normalize_messages(msgs_raw if isinstance(msgs_raw, list) else [])
    if not msgs:
        return
    sys_prompt, turns = _split_per_turn(msgs)
    if not turns:
        return
    tools_list = _normalize_tools(r.get("tools"))
    base_id = str(r.get("id") or "")
    for idx, (memory, current, assistant) in enumerate(turns):
        extra: dict[str, Any] = {
            "original_id": f"{base_id}#{idx}" if base_id else "",
            "turn_index": idx,
            "turns_total": len(turns),
        }
        yield _build_messages_record(
            slug=slug, license=license, split=split,
            sys_prompt=sys_prompt, memory=memory, current=current,
            assistant=assistant, encoder=encoder, tools_list=tools_list,
            default_task_type="mcp_tool_call",
            extra_metadata=extra,
            room_seed=f"{base_id}#{idx}" if base_id else f"{current['content'][:120]}#{idx}",
        )


def mcp_routing(records, *, slug, license, split, encoder):
    for r in records:
        if isinstance(r.get("messages"), list) or isinstance(r.get("conversations"), list):
            yield from _generic_messages(iter([r]), slug=slug, license=license, split=split,
                messages_key=lambda x: x.get("messages") or x.get("conversations") or [],
                encoder=encoder, default_task_type="mcp_tool_call", tools_key="tools")
            continue
        query = r.get("query") or r.get("input") or r.get("instruction") or ""
        if not query:
            continue
        target = {
            "server": r.get("server") or r.get("mcp_server") or r.get("expected_server") or "",
            "tool": r.get("tool") or r.get("expected_tool") or "",
            "arguments": r.get("arguments") or r.get("params") or {},
        }
        expected_response = encoder.encode(target)
        yield build(
            roomName=stable_id(slug, r.get("id") or query[:120]),
            agentId="mcp-router",
            currentMessage={"role": "user", "speaker": "user", "content": query, "channel": "dm"},
            memoryEntries=[],
            expectedResponse=expected_response,
            availableActions=[ACTION_TASKS, ACTION_IGNORE],
            task_type="mcp_routing",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={"original_id": str(r.get("id") or "")},
        )


def _mcp_flow_parse_function_call(fc: Any) -> dict[str, Any] | None:
    """Decode the `function_call` field, which may be a `{name, arguments}`
    dict or a JSON-encoded string of the same."""
    if isinstance(fc, str):
        try:
            fc = json.loads(fc)
        except json.JSONDecodeError:
            return None
    if not isinstance(fc, dict):
        return None
    name = fc.get("name") or ""
    args = fc.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"raw": args}
    if not name:
        return None
    return {"name": name, "arguments": args if isinstance(args, dict) else {}}


def mcp_flow(records, *, slug, license, split, encoder):
    """wwh0411/MCP-Flow — two record shapes both surface as `mcp_tool_call`:

    1. `function_call/<provider>/<server>.json` — list of
       `{source_instruction, function_call: {name, arguments}, tool}` rows.
       One supervised tool call per row, anchored on `source_instruction`.

    2. `test_data/*.json` — list of
       `{instruction, server_name, tool_name, function_call: <json-str>,
       tools: <json-str>, conversations}` rows. The `tools` field carries
       the full set of tool specs available; we keep it under
       `metadata.toolSpecs`.

    The legacy `{name, examples}` per-tool-spec shape this adapter formerly
    targeted is not present in the dataset as shipped — there are no
    `examples` arrays anywhere under `function_call/`. So we only handle
    the two real shapes above.
    """
    for r in records:
        # Shape 2: test_data with full tool list.
        if "instruction" in r and "function_call" in r:
            user_q = r.get("instruction") or ""
            call = _mcp_flow_parse_function_call(r.get("function_call"))
            if not user_q or not call:
                continue
            tools_raw = r.get("tools")
            tools_list = _normalize_tools(tools_raw)
            calls = [call]
            expected_response = encoder.encode(_planner_tool_envelope(
                thought="", tool_calls=calls, providers=[],
            ))
            yield build(
                roomName=stable_id(slug, call["name"], user_q[:80]),
                agentId="mcp-agent",
                currentMessage={"role": "user", "speaker": "user", "content": user_q, "channel": "dm"},
                memoryEntries=[],
                expectedResponse=expected_response,
                availableActions=[ACTION_TASKS, ACTION_IGNORE],
                task_type="mcp_tool_call",
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata={
                    "server_name": r.get("server_name") or "",
                    "tool_name": call["name"],
                    "toolSpecs": tools_list,
                    "expected_tool_calls": calls,
                },
            )
            continue

        # Shape 1: function_call/<provider>/<server>.json single example.
        if "source_instruction" in r and "function_call" in r:
            user_q = r.get("source_instruction") or ""
            call = _mcp_flow_parse_function_call(r.get("function_call"))
            if not user_q or not call:
                continue
            calls = [call]
            expected_response = encoder.encode(_planner_tool_envelope(
                thought="", tool_calls=calls, providers=[],
            ))
            yield build(
                roomName=stable_id(slug, call["name"], user_q[:80]),
                agentId="mcp-agent",
                currentMessage={"role": "user", "speaker": "user", "content": user_q, "channel": "dm"},
                memoryEntries=[],
                expectedResponse=expected_response,
                availableActions=[ACTION_TASKS, ACTION_IGNORE],
                task_type="mcp_tool_call",
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata={
                    "tool_name": call["name"],
                    "expected_tool_calls": calls,
                },
            )
            continue


# ─────────────────── shell / terminal / agent_trove ─────────────────────────


def _shell_target(command: str, explanation: str = "", cwd: str = "") -> dict[str, Any]:
    """Build a SHELL planner-envelope target.

    Returns the canonical 5-key planner envelope (PIPELINE_SCHEMAS.md §1+§7)
    with `actions[].name == SHELL` carrying the shell parameters.
    The `explanation` is folded into `thought:` when present; otherwise we
    use the generic shell default.
    """
    return _planner_shell_envelope(
        thought=_strip_surrogates(explanation),
        command=command, explanation=explanation, cwd=cwd,
        text="", providers=[],
    )


def _terminal_assistant_extract(content: str) -> tuple[str, str]:
    """Parse a nemotron-terminal-corpus / agent-trove style assistant turn.

    The conversational shape is `<think>...</think>\\n\\n{"analysis":...,
    "plan":..., "commands":[{"keystrokes":...}, ...], "task_complete":...}`.
    Some turns ship the JSON without the `<think>` prefix; some ship a
    fenced bash block instead of JSON.

    Returns (command, explanation) where:
      - command:     keystrokes joined with `\\n`, or the fenced bash text,
                     or the raw content fallback.
      - explanation: any extracted thought (`<think>` body) plus the
                     `analysis` / `plan` text from the JSON envelope.
                     Empty string if nothing usable is found.
    """
    content = (content or "").strip()
    if not content:
        return "", ""

    explanation_parts: list[str] = []

    # 1. <think>…</think> prefix carries the planner reasoning.
    mt = _THINK_RE.match(content)
    if mt:
        thought = mt.group(1).strip()
        if thought:
            explanation_parts.append(thought)
        body = content[mt.end():].strip()
    else:
        body = content

    # 2. JSON envelope: {"analysis": ..., "plan": ..., "commands": [...]}.
    cmd = ""
    is_json_envelope = False
    if body.startswith("{") and body.endswith("}"):
        try:
            obj = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            obj = None
        if isinstance(obj, dict) and ("commands" in obj or "analysis" in obj or "plan" in obj):
            is_json_envelope = True
            analysis = obj.get("analysis")
            plan = obj.get("plan")
            if isinstance(analysis, str) and analysis.strip():
                explanation_parts.append(analysis.strip())
            if isinstance(plan, str) and plan.strip():
                explanation_parts.append("Plan: " + plan.strip())
            commands = obj.get("commands")
            if isinstance(commands, list):
                ks_parts: list[str] = []
                for c in commands:
                    if isinstance(c, dict):
                        ks = c.get("keystrokes")
                        if isinstance(ks, str) and ks.strip():
                            ks_parts.append(ks.rstrip("\n"))
                if ks_parts:
                    cmd = "\n".join(ks_parts)

    # 3. Fenced bash block fallback (when there was no JSON envelope).
    if not cmd and not is_json_envelope:
        for m in re.finditer(r"```(?:bash|sh)?\s*\n([\s\S]*?)```", body):
            cmd = m.group(1).strip()
            break

    if not cmd and not is_json_envelope:
        cmd = body

    # If we recognized a JSON envelope but the commands list was empty,
    # this is a `task_complete: true` terminator with no shell command —
    # not a real shell_command record. Caller should drop it.
    if is_json_envelope and not cmd:
        return "", ""

    explanation = "\n\n".join(p for p in explanation_parts if p).strip()
    return cmd, explanation


def terminal_corpus(records, *, slug, license, split, encoder):
    """laion/nemotron-terminal-corpus-unified — emit SHELL records."""
    for r in records:
        # The corpus has a few shapes; we try common ones.
        if isinstance(r.get("messages"), list) or isinstance(r.get("conversations"), list):
            msgs = r.get("messages") or r.get("conversations") or []
            sys_prompt, memory, current, final = _split_history(msgs)
            if not final or not current:
                continue
            command, explanation = _terminal_assistant_extract(final.get("content", "") or "")
            if not command:
                continue
            expected_response = encoder.encode(_shell_target(command, explanation))
            yield build(
                roomName=stable_id(slug, current["content"][:120]),
                agentId="agent",
                memoryEntries=memory,
                currentMessage=current,
                expectedResponse=expected_response,
                availableActions=[ACTION_SHELL, ACTION_REPLY, ACTION_IGNORE],
                task_type="shell_command",
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata={"system_prompt": sys_prompt} if sys_prompt else {},
            )
            continue

        instruction = r.get("instruction") or r.get("query") or r.get("prompt") or ""
        command = r.get("command") or r.get("output") or r.get("response") or ""
        explanation = r.get("explanation") or r.get("rationale") or r.get("reasoning") or ""
        if not instruction or not command:
            continue
        expected_response = encoder.encode(_shell_target(str(command), str(explanation)))
        yield build(
            roomName=stable_id(slug, r.get("id") or instruction[:120]),
            agentId="agent",
            memoryEntries=[],
            currentMessage={"role": "user", "speaker": "user", "content": instruction, "channel": "dm"},
            expectedResponse=expected_response,
            availableActions=[ACTION_SHELL, ACTION_REPLY, ACTION_IGNORE],
            task_type="shell_command",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={"original_id": str(r.get("id") or "")},
        )


def agent_trove(records, *, slug, license, split, encoder):
    """open-thoughts/AgentTrove — agent trajectories. Use generic messages
    path; if the final assistant turn looks like a shell command, label as
    shell_command, else tool_call/agent_trace.

    For shell-command turns we lift `analysis` + `plan` out of the JSON
    envelope into `explanation:`. For agent_trace turns the same fields
    are lifted into `thought:` by `_build_messages_record` via
    `_split_thought_and_body` / `_extract_agent_trove_json_thought`.
    """
    for r in records:
        msgs = r.get("messages") or r.get("conversations") or r.get("trajectory") or []
        if not msgs:
            continue
        sys_prompt, memory, current, final = _split_history(msgs)
        if not final or not current:
            continue
        content = final.get("content", "") or ""

        # Check for agent-trove JSON envelope (preferred) or fenced bash.
        is_json_shell = False
        body = content.strip()
        if body.startswith("{") and body.endswith("}"):
            try:
                obj = json.loads(body)
                if isinstance(obj, dict) and isinstance(obj.get("commands"), list) \
                        and any(isinstance(c, dict) and c.get("keystrokes") for c in obj.get("commands") or []):
                    is_json_shell = True
            except (json.JSONDecodeError, ValueError):
                pass
        # Also handle <think>...</think>{...json envelope...}.
        if not is_json_shell:
            mt = _THINK_RE.match(body)
            if mt:
                rest = body[mt.end():].strip()
                if rest.startswith("{") and rest.endswith("}"):
                    try:
                        obj = json.loads(rest)
                        if isinstance(obj, dict) and isinstance(obj.get("commands"), list) \
                                and any(isinstance(c, dict) and c.get("keystrokes") for c in obj.get("commands") or []):
                            is_json_shell = True
                    except (json.JSONDecodeError, ValueError):
                        pass
        m = re.search(r"```(?:bash|sh)\s*\n([\s\S]*?)```", content) if not is_json_shell else None

        if is_json_shell or m:
            command, explanation = _terminal_assistant_extract(content)
            if not command:
                # task_complete: true terminator with no actual shell
                # command — drop it (audit B-4 confirms these are noise).
                continue
            expected_response = encoder.encode(_shell_target(command, explanation))
            yield build(
                roomName=stable_id(slug, r.get("id") or current["content"][:120]),
                agentId="agent",
                memoryEntries=memory,
                currentMessage=current,
                expectedResponse=expected_response,
                availableActions=[ACTION_SHELL, ACTION_REPLY, ACTION_IGNORE],
                task_type="shell_command",
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata={"system_prompt": sys_prompt} if sys_prompt else {},
            )
            continue
        # Fall through to generic: agent_trace / tool_call / reply, with
        # `_build_messages_record` lifting analysis/plan into `thought:`.
        tools_list = _normalize_tools(r.get("tools"))
        yield _build_messages_record(
            slug=slug, license=license, split=split,
            sys_prompt=sys_prompt, memory=memory, current=current,
            assistant=final, encoder=encoder, tools_list=tools_list,
            default_task_type="agent_trace",
            extra_metadata={"original_id": str(r.get("id") or "")},
        )


# ───────────────────────── reasoning / CoT family ───────────────────────────

def reasoning_cot(records, *, slug, license, split, encoder):
    """Generic reasoning/CoT corpora (Jackrong DeepSeek/GLM/Kimi/Qwen/glm-4.7,
    open-paws, Akicou, and friends).

    The supervised target is structured `{thought, text}`. Source corpora ship
    a `<think>…</think>` block followed by the answer; we extract the
    block into `thought` and put the remainder in `text`. Tool calls
    inside take the tool_call path.
    """
    for r in records:
        msgs = (
            r.get("messages") or r.get("conversations") or r.get("conversation")
            or r.get("trajectory") or r.get("dialogue") or []
        )
        if not msgs:
            # Some Jackrong shards ship {"prompt", "response"} pairs.
            prompt = r.get("prompt") or r.get("instruction") or r.get("input") or ""
            response = r.get("response") or r.get("output") or r.get("completion") or ""
            if not prompt or not response:
                continue
            yield build(
                roomName=stable_id(slug, r.get("id") or prompt[:120]),
                agentId="agent",
                currentMessage={"role": "user", "speaker": "user", "content": str(prompt), "channel": "dm"},
                memoryEntries=[],
                expectedResponse=_cot_to_expected(encoder, str(response)),
                availableActions=REPLY_ACTIONS.copy(),
                task_type="reasoning_cot",
                source_dataset=slug,
                license=license,
                split=split,
                extra_metadata={"original_id": str(r.get("id") or "")},
            )
            continue
        sys_prompt, memory, current, final = _split_history(msgs)
        if not final or not current:
            continue
        calls = _extract_tool_calls(final)
        text = final.get("content", "") or ""
        extra_thought = str(final.get("_pending_thought") or "")
        thought, body = _split_thought_and_body(text)
        if extra_thought:
            thought = (extra_thought.strip() + ("\n\n" + thought if thought else "")).strip()
        if calls:
            target = encoder.encode(_planner_tool_envelope(
                thought=thought, tool_calls=calls, text=body, providers=[],
            ))
            actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
            tt = "tool_call"
        else:
            target = _cot_to_expected(encoder, text, extra_thought=extra_thought)
            actions = REPLY_ACTIONS.copy()
            tt = "reasoning_cot"
        md = {"original_id": str(r.get("id") or "")}
        if sys_prompt:
            md["system_prompt"] = sys_prompt
        if calls:
            md["expected_tool_calls"] = calls
        yield build(
            roomName=stable_id(slug, r.get("id") or current["content"][:120]),
            agentId="agent",
            memoryEntries=memory,
            currentMessage=current,
            expectedResponse=target,
            availableActions=actions,
            task_type=tt,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )


# ─────────────── nubilio trajectories (self-hosted milady bot) ──────────────

# Filename → (task_type, available_actions)
#
# The first five files are emitted by elizaOS app-training's
# `exportTrajectoryTaskDatasets` (eliza/apps/app-training/src/core/
# trajectory-task-datasets.ts). Three of them — should_respond,
# context_routing, media_description — ship as empty files until the
# nubilio runtime actually emits LLM calls with the matching purpose
# hints (see `inferTasksForCall` in that file). They become populated
# automatically once those code paths fire (LLM-based shouldRespond
# evaluation, context-routing decisions, image-description model
# calls); no adapter change is needed when that happens.
#
# `reflection_trajectories.jsonl` and `reflection_evaluator_trajectories.jsonl`
# are forward-compat entries: the elizaOS reflection prompts
# (`prompts/reflection.txt`, `prompts/reflection_evaluator.txt`) emit
# TOON `key: value` documents (`thought:`, `quality_score:`, `facts[i]:`,
# `relationships[i]:`, `task_completed:` …) which round-trip through
# the existing yaml-thought parser. They are mapped here so the runtime
# can start writing them without a follow-up adapter patch.
_NUBILIO_TASK_MAP: dict[str, tuple[str, list[str]]] = {
    "action_planner_trajectories.jsonl":     ("agent_trace",          [ACTION_REPLY, ACTION_TASKS, ACTION_IGNORE]),
    "response_trajectories.jsonl":            ("reply",                REPLY_ACTIONS.copy()),
    "should_respond_trajectories.jsonl":      ("should_respond",       ROUTING_ACTIONS.copy()),
    "context_routing_trajectories.jsonl":     ("context_routing",      ROUTING_ACTIONS.copy()),
    "media_description_trajectories.jsonl":   ("media_description",    REPLY_ACTIONS.copy()),
    "reflection_trajectories.jsonl":          ("reflection",           REPLY_ACTIONS.copy()),
    "reflection_evaluator_trajectories.jsonl": ("reflection_evaluator", REPLY_ACTIONS.copy()),
}


def _coerce_scalar(s: str) -> Any:
    """Best-effort cast of a string to bool/int/float/null, else strip & return."""
    t = s.strip()
    if t == "":
        return ""
    if t.lower() == "true":
        return True
    if t.lower() == "false":
        return False
    if t.lower() in ("null", "none"):
        return None
    if re.fullmatch(r"-?\d+", t):
        return int(t)
    if re.fullmatch(r"-?\d+\.\d+", t):
        return float(t)
    return t


def _xml_element_to_value(el: Any) -> Any:
    """Convert an ElementTree element to a JSON-friendly value.

    Leaf elements → coerced scalar. Elements with children → dict mapping
    child tag → value. Repeated child tags collapse into a list.
    """
    children = list(el)
    text = (el.text or "").strip()
    if not children:
        return _coerce_scalar(text)
    out: dict[str, Any] = {}
    for child in children:
        val = _xml_element_to_value(child)
        if child.tag in out:
            existing = out[child.tag]
            if isinstance(existing, list):
                existing.append(val)
            else:
                out[child.tag] = [existing, val]
        else:
            out[child.tag] = val
    # Preserve text content alongside children when both exist (rare).
    if text:
        out.setdefault("_text", _coerce_scalar(text))
    return out


def _parse_response_xml(xml: str) -> dict[str, Any] | None:
    """Parse the elizaOS planner `<response>...</response>` blob into a dict.

    Tolerates the common `</actions>` typo where `<action>` close tags are
    missing. Falls back to None if parsing fails entirely so the caller
    can hold the original string instead of corrupting the corpus.
    """
    body = xml.strip()
    if not body.startswith("<response>"):
        return None
    # Tolerate the LLM's common malformed pattern:
    #   <action><name>X</name></actions>
    # where the trailing close tag should have been </action></actions>.
    # We only patch when we see an unmatched </actions>.
    import xml.etree.ElementTree as ET  # stdlib
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        # Pattern A: `<action>...</actions>` with no `</action>` close.
        patched = re.sub(
            r"(<action>\s*<name>[^<]*</name>)\s*</actions>",
            r"\1</action></actions>",
            body,
        )
        patched = re.sub(
            r"(<action>\s*<name>[^<]*</name>\s*<params>[\s\S]*?</params>)\s*</actions>",
            r"\1</action></actions>",
            patched,
        )
        # Pattern B: doubled `</actions></actions>` after the patch (or
        # in the original). Collapse to one.
        patched = re.sub(r"(</actions>)(\s*</actions>)+", r"\1", patched)
        try:
            root = ET.fromstring(patched)
        except ET.ParseError:
            return None

    if root.tag != "response":
        return None

    out: dict[str, Any] = {}
    for child in root:
        tag = child.tag
        if tag == "actions":
            actions: list[Any] = []
            for action_el in child.findall("action"):
                a = _xml_element_to_value(action_el)
                # Common case: <action><name>NAME</name></action> → string "NAME"
                if isinstance(a, dict) and set(a.keys()) == {"name"}:
                    actions.append(a["name"])
                else:
                    actions.append(a if isinstance(a, dict) else {"name": a})
            out["actions"] = actions
        elif tag == "providers":
            providers: list[Any] = []
            for p_el in child.findall("provider"):
                p = _xml_element_to_value(p_el)
                providers.append(p["name"] if isinstance(p, dict) and set(p.keys()) == {"name"} else p)
            # Empty <providers></providers> → []
            out["providers"] = providers
        else:
            out[tag] = _xml_element_to_value(child)
    return out


_YAML_KEY_LINE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$")


def _parse_yaml_thought(text: str) -> dict[str, Any] | None:
    """Parse a `key: value\\nkey2: value2` block into a dict.

    Used for the planner's "yaml-style" outputs (mostly evaluation-purpose
    LLM calls that emit `thought: …\\ntext: …`). Tolerates multi-line
    string values via continuation indentation.
    """
    body = text.strip()
    if not body:
        return None
    out: dict[str, Any] = {}
    current_key: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if current_key is None:
            return
        joined = "\n".join(buf).strip()
        # Strip surrounding quotes if present.
        if (joined.startswith('"') and joined.endswith('"')) or \
           (joined.startswith("'") and joined.endswith("'")):
            joined = joined[1:-1]
        out[current_key] = _coerce_scalar(joined) if "\n" not in joined else joined

    for raw in body.splitlines():
        m = _YAML_KEY_LINE.match(raw)
        if m and (raw[0:1].isalpha() or raw[0:1] == "_"):
            flush()
            current_key = m.group(1)
            buf = [m.group(2)]
        else:
            if current_key is None:
                return None
            buf.append(raw)
    flush()
    if not out:
        return None
    return out


_MD_JSON_FENCE = re.compile(r"^```(?:json)?\s*\n([\s\S]*?)\n```\s*$", re.MULTILINE)


def _parse_md_json_fence(text: str) -> Any | None:
    body = text.strip()
    m = _MD_JSON_FENCE.match(body)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _nubilio_response_to_dict(text: str) -> tuple[dict[str, Any] | list[Any] | None, str]:
    """Best-effort parse of a nubilio assistant turn into a structured value.

    Returns (parsed_value, source_format). When parsing fails, returns
    (None, "raw"). Recognized formats:
      - "xml-response"  : full <response>...</response> planner XML
      - "json-obj"      : a top-level JSON object (e.g. {"providers":[]})
      - "json-array"    : a JSON array
      - "yaml-thought"  : `key: value` block (often `thought:` / `text:`)
      - "md-fence"      : ```json …``` fenced JSON
      - "raw"           : unparseable; fall back to {thought:"", text:<raw>}
    """
    body = text.strip()
    if body.startswith("<response>"):
        parsed = _parse_response_xml(body)
        if parsed is not None:
            return parsed, "xml-response"
    if body.startswith("{"):
        try:
            return json.loads(body), "json-obj"
        except json.JSONDecodeError:
            pass
    if body.startswith("["):
        try:
            return json.loads(body), "json-array"
        except json.JSONDecodeError:
            pass
    if body.startswith("```"):
        parsed = _parse_md_json_fence(body)
        if parsed is not None:
            return parsed, "md-fence"
    if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*\s*:", body):
        parsed = _parse_yaml_thought(body)
        if parsed is not None:
            return parsed, "yaml-thought"
    return None, "raw"


def nubilio_trajectories(records, *, slug, license, split, encoder):
    """Cron-snapshot trajectories from the self-hosted nubilio milady bot.

    Each line is `{"messages": [system, user, ..., assistant]}`. The
    assistant content is parsed (XML / JSON / YAML-thought) and re-encoded
    with the configured expected-response encoder so the supervised target matches the elizaOS runtime decoder.

    Filename selects task_type via `_NUBILIO_TASK_MAP`. Cross-file dedup
    uses the (system, last-user, assistant) triple.
    """
    seen: set[str] = set()
    for r in records:
        msgs = r.get("messages") or []
        if not msgs:
            continue
        sys_prompt, memory, current, final = _split_history(msgs)
        if not final or not current:
            continue
        assistant_text = final.get("content") or ""
        if not assistant_text.strip():
            continue

        source_file = r.get("_source_filename", "")
        task_type, actions = _NUBILIO_TASK_MAP.get(
            source_file, ("agent_trace", [ACTION_REPLY, ACTION_TASKS, ACTION_IGNORE]),
        )

        dedup = stable_id(sys_prompt[:512], current["content"][:512], assistant_text[:512])
        if dedup in seen:
            continue
        seen.add(dedup)

        parsed, fmt = _nubilio_response_to_dict(assistant_text)
        if parsed is None:
            # Plain text reply → emit as structured `{text}` (drop empty thought
            # so the student model doesn't learn to produce `thought: ""`).
            # Any embedded `<think>` block is lifted by `_cot_to_expected`.
            target = _cot_to_expected(encoder, assistant_text)
        else:
            try:
                target = encoder.encode(parsed)
            except (ValueError, TypeError):
                # Fall back to wrapping the raw assistant text — keeps the
                # supervised target valid structured output even when the structured parse
                # produced something the encoder rejects.
                target = _cot_to_expected(encoder, assistant_text)
                fmt = "raw"

        md: dict[str, Any] = {
            "original_id": dedup,
            "nubilio_source_file": source_file,
            "nubilio_response_format": fmt,
        }
        if sys_prompt:
            md["system_prompt"] = sys_prompt

        yield build(
            roomName=stable_id(slug, source_file, dedup),
            agentId="remilio-nubilio",
            memoryEntries=memory,
            currentMessage=current,
            expectedResponse=target,
            availableActions=actions,
            task_type=task_type,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )


# ───────────── scam-defense corpus (full-corpus-unweighted) ────────────────

# Categories that are NOT scam-defense scenarios. Anything not in this set
# is treated as a scam-defense interaction.
_LEGITIMATE_CATEGORIES = {
    "legitimate", "benign", "banking-inquiry", "security-inquiry",
    "small-talk", "general",
}


def _scam_defense_flag(category: str | None) -> bool:
    if not category:
        return False
    if category.startswith("legitimate"):
        return False
    return category not in _LEGITIMATE_CATEGORIES


def _normalize_action(action: str) -> str:
    """request-verification → request_verification (match scambench shape)."""
    return action.replace("-", "_").strip().lower() if action else ""


def _parse_scam_user_prompt(prompt: str) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Split the scam-defense userPrompt into (runtime_context, transcript).

    The userPrompt has the shape:

        Runtime context:
        { ...JSON... }

        Conversation transcript:
        [Speaker]: line
        [Speaker]: line
        ...
    """
    ctx: dict[str, Any] | None = None
    transcript: list[dict[str, str]] = []

    parts = prompt.split("Conversation transcript:", 1)
    if len(parts) == 2:
        head, tail = parts
        # Find the runtime-context JSON object
        ctx_start = head.find("{")
        if ctx_start != -1:
            depth = 0
            for i, ch in enumerate(head[ctx_start:], start=ctx_start):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            ctx = json.loads(head[ctx_start:i + 1])
                        except json.JSONDecodeError:
                            ctx = None
                        break
        body = tail
    else:
        body = prompt

    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line.startswith("["):
            continue
        end = line.find("]:")
        if end == -1:
            continue
        speaker = line[1:end].strip()
        content = line[end + 2:].strip()
        if not speaker or not content:
            continue
        transcript.append({"speaker": speaker, "content": content})
    return ctx, transcript


def scam_defense_corpus(records, *, slug, license, split, encoder):
    """Full-corpus-unweighted scam-defense trajectories.

    Each record is `{"trajectory": {steps: [{llmCalls: [...]}]}}`. Each
    llmCall has systemPrompt, userPrompt (runtime_context + transcript),
    response (often `<think>…</think>\\n<final text>`). Emits one
    ElizaRecord per llmCall with task_type=`scam_defense` and
    expectedResponse passed through verbatim (preserves the `<think>`
    block alongside the final reply).
    """
    seen: set[str] = set()
    for r in records:
        traj = r.get("trajectory") or {}
        agent_id = str(traj.get("agentId") or "agent")
        traj_id = str(traj.get("id") or traj.get("trajectoryId") or "")
        archetype = traj.get("archetype") or ""
        meta_json: dict[str, Any] = {}
        raw_meta = traj.get("metadataJson")
        if isinstance(raw_meta, str):
            try:
                meta_json = json.loads(raw_meta)
            except json.JSONDecodeError:
                meta_json = {}
        elif isinstance(raw_meta, dict):
            meta_json = raw_meta

        for step in traj.get("steps") or []:
            for call_idx, call in enumerate(step.get("llmCalls") or []):
                sys_prompt = str(call.get("systemPrompt") or "")
                user_prompt = str(call.get("userPrompt") or "")
                response = str(call.get("response") or "")
                if not user_prompt or not response:
                    continue

                ctx, transcript = _parse_scam_user_prompt(user_prompt)
                if not transcript:
                    continue

                memory = [
                    {
                        "role": "assistant" if t["speaker"] == agent_id else "user",
                        "speaker": t["speaker"],
                        "content": t["content"],
                        "channel": "dm",
                    }
                    for t in transcript[:-1]
                ]
                last = transcript[-1]
                # Drop trailing agent turns; we want the most recent inbound turn
                # as currentMessage so the supervised target is the next reply.
                while memory and last["speaker"] == agent_id:
                    last = memory.pop()
                if last["speaker"] == agent_id:
                    continue
                current = {
                    "role": "user",
                    "speaker": last["speaker"],
                    "content": last["content"],
                    "channel": "dm",
                }

                dedup = stable_id(traj_id, step.get("stepNumber", 0), call_idx, response[:512])
                if dedup in seen:
                    continue
                seen.add(dedup)

                action = step.get("action") or {}
                action_type = action.get("actionType") or call.get("actionType") or ""
                params = action.get("parameters") or {}
                chosen_action = (
                    params.get("chosenAction")
                    or meta_json.get("chosenAction")
                    or ""
                )
                avail = []
                if isinstance(ctx, dict):
                    for a in ctx.get("availableActions") or []:
                        if isinstance(a, dict) and a.get("name"):
                            avail.append(a["name"])
                if not avail:
                    avail = REPLY_ACTIONS.copy()
                # Normalize lowercase scam-defense decision names
                # (refuse / escalate / accept / etc.) to canonical eliza
                # actions (REPLY / IGNORE) — eliza runtime parsers expect
                # uppercase.
                avail = _normalize_scam_actions(avail)

                category = meta_json.get("category")
                reasoning, final_text = _split_think_response(response)
                # Prefer the action.result.responseText when present — that's
                # the canonical agent reply; the LLM `response` field may
                # carry trailing chain-of-thought we already split out.
                result_text = ""
                if isinstance(action.get("result"), dict):
                    result_text = str(action["result"].get("responseText") or "")
                final_response = result_text or final_text

                # Map the upstream decision class to a planner-envelope
                # action (PIPELINE_SCHEMAS.md §9). `block` / `ignore` /
                # `decline` / `refuse` → IGNORE; everything else → REPLY.
                norm_action = _normalize_action(chosen_action).lower()
                if norm_action in ("ignore", "block", "decline_to_answer", "decline", "refuse"):
                    target = _planner_ignore_envelope(
                        thought=reasoning,
                        text=final_response,
                        seed=final_response,
                    )
                else:
                    target = _planner_reply_envelope(
                        thought=reasoning,
                        text=final_response, providers=[],
                        seed=final_response,
                    )
                target = encoder.encode(target)

                md: dict[str, Any] = {
                    "original_id": dedup,
                    "trajectory_id": traj_id,
                    "step_number": step.get("stepNumber"),
                    "call_index": call_idx,
                    "archetype": archetype,
                    "purpose": call.get("purpose"),
                    "action_type": action_type,
                    "chosen_action": chosen_action,
                    "category": category,
                    "scenario_category": category,
                    "should_trigger_scam_defense": _scam_defense_flag(category),
                    "language": meta_json.get("language"),
                    "style_variant": meta_json.get("styleVariant"),
                    "scenario_profile": meta_json.get("scenarioProfile"),
                    "source_pool": meta_json.get("sourcePool"),
                    "has_reasoning": meta_json.get("hasReasoning"),
                    "reasoning_source": call.get("reasoningSource"),
                    "reward": step.get("reward"),
                }
                if sys_prompt:
                    md["system_prompt"] = sys_prompt
                if isinstance(ctx, dict):
                    md["runtime_context"] = ctx

                yield build(
                    roomName=stable_id(slug, dedup),
                    agentId=agent_id,
                    memoryEntries=memory,
                    currentMessage=current,
                    expectedResponse=target,
                    availableActions=avail,
                    task_type="scam_defense",
                    source_dataset=slug,
                    license=license,
                    split=split,
                    extra_metadata=md,
                )


# ─────────────────────────── n8n workflow generation ───────────────────────
#
# The runtime entry point is `parseWorkflowResponse()` in
# `@elizaos/plugin-n8n-workflow/dist/utils/generation.js`: it strips the
# leading ```json … ``` markdown fence and JSON.parses the body. The
# planner-level XML envelope (`<response>…</response>` wrapping a
# CREATE_WORKFLOW action) is the higher-level form the agent emits when it
# is choosing between actions — the JSON is then carried inline inside
# `<params>`. We emit BOTH shapes (50/50, deterministic by record index)
# so the SFT target distribution covers either form.
#
# `expectedResponse` is raw text — no TOON wrapping. The workflow JSON is
# already structured and often multi-KB; double-encoding bloats tokens.

# Action surface the planner sees on n8n turns.
N8N_WORKFLOW_ACTIONS = ["CREATE_WORKFLOW", "PREVIEW_WORKFLOW", "REPLY", "IGNORE"]


def _n8n_synth_prompt_from_workflow(wf: dict[str, Any]) -> str:
    """Build a synthetic user prompt from a raw n8n workflow JSON."""
    name = (wf.get("name") or "").strip() or "an n8n workflow"
    nodes = wf.get("nodes") or []
    types = []
    for n in nodes if isinstance(nodes, list) else []:
        t = (n.get("type") if isinstance(n, dict) else None) or ""
        if t and t not in types:
            types.append(t)
        if len(types) >= 12:
            break
    integrations = ", ".join(types[:12]) if types else "various nodes"
    return (
        f"Generate the JSON for an n8n workflow named '{name}' that uses "
        f"these node types: {integrations}. Return only the workflow JSON."
    )


def _n8n_first_str(d: dict[str, Any], keys: list[str]) -> str:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return ""


_N8N_FENCE_RE = re.compile(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", re.IGNORECASE)


def _n8n_extract_workflow(text: str) -> dict[str, Any] | None:
    """Return a workflow dict (must contain `nodes` + `connections`) parsed
    from `text`, or None if no valid workflow can be recovered.

    Tolerates raw JSON, ```json fenced JSON, and prose-prefixed JSON (the
    `<thinking>…JSON…` shape used by stmasson and the markdown analysis
    shape used by davidrpatton).
    """
    if not isinstance(text, str) or not text.strip():
        return None
    body = text.strip()

    # 1) Direct JSON.
    try:
        wf = json.loads(body)
        if isinstance(wf, dict) and isinstance(wf.get("nodes"), list) \
                and isinstance(wf.get("connections"), dict):
            return wf
    except json.JSONDecodeError:
        pass

    # 2) Fenced JSON block(s) — pick the first that yields a valid workflow.
    for m in _N8N_FENCE_RE.finditer(body):
        chunk = m.group(1).strip()
        try:
            wf = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if isinstance(wf, dict) and isinstance(wf.get("nodes"), list) \
                and isinstance(wf.get("connections"), dict):
            return wf

    # 3) First `{` … last `}` window. Useful for `<thinking>…{…}` shapes.
    first = body.find("{")
    last = body.rfind("}")
    if first >= 0 and last > first:
        try:
            wf = json.loads(body[first:last + 1])
        except json.JSONDecodeError:
            return None
        if isinstance(wf, dict) and isinstance(wf.get("nodes"), list) \
                and isinstance(wf.get("connections"), dict):
            return wf
    return None


def _n8n_planner_target(wf: dict[str, Any]) -> dict[str, Any]:
    """Build the canonical elizaOS planner output for a CREATE_WORKFLOW
    action, as a Python dict ready to encode.

    Shape mirrors the `<response>` XML envelope nubilio emits — `thought`,
    `actions[]{name, params}`, `providers[]`, `text`, `simple` — so the
    student model learns one envelope across both runtime tasks and
    workflow generation.
    """
    name = (wf.get("name") or "").strip() or "untitled"
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    n_count = len(nodes)
    trigger = ""
    sink = ""
    for n in nodes:
        if not isinstance(n, dict):
            continue
        t = (n.get("type") or "").lower()
        if not trigger and ("trigger" in t or "webhook" in t or t.endswith("formtrigger")):
            trigger = n.get("name") or t.split(".")[-1] or "trigger"
        if "googlesheets" in t or "telegram" in t or "slack" in t or "notion" in t \
                or "gmail" in t or "discord" in t or "airtable" in t:
            sink = n.get("name") or t.split(".")[-1] or sink
    if not trigger:
        trigger = "trigger"
    if not sink:
        if nodes and isinstance(nodes[-1], dict):
            last = nodes[-1]
            sink = last.get("name") or (last.get("type") or "").split(".")[-1] or "action"
        else:
            sink = "action"
    return {
        "thought": (
            f"User wants a {trigger} to {sink} workflow. "
            f"Drafting with {n_count} nodes."
        ),
        "actions": [{
            "name": "CREATE_WORKFLOW",
            "params": {"workflow": wf},
        }],
        "providers": [],
        "text": (
            f"Drafted '{name}' with {n_count} nodes. Connect any required "
            f"credentials, then confirm to deploy."
        ),
        "simple": False,
    }


def n8n_workflow(records, *, slug, license, split, encoder):
    """Universal adapter for n8n workflow-generation datasets.

    Detects six common input shapes and emits one ElizaRecord per row with
    `task_type='n8n_workflow_generation'`. The supervised target is the
    elizaOS planner envelope encoded with the configured expected-response encoder — `thought`, `actions[]
    {name, params:{workflow}}`, `providers[]`, `text`, `simple` — matching
    nubilio's runtime planner output exactly.

    Input shapes handled:
      A) {messages:[{role,content},...]}                    — OpenAI/SFT
      B) {prompt|instruction|input, json|answer|output|completion[, thinking]}
      C) {workflow_json, workflow_name, integrations, ...}  — Ker102 master
      D) {name, nodes, connections}                          — batuhanilgarr
      E) {key, value}                                        — 0xarchit kv
      F) {prompt, chosen, rejected, ...}                     — DPO (uses chosen)
    """
    seen: set[str] = set()
    emitted = 0
    for r in records:
        if not isinstance(r, dict):
            continue

        prompt_text: str = ""
        target_text: str = ""
        memory: list[dict[str, Any]] = []
        sys_prompt: str = ""
        thinking: str = ""

        # Shape A: messages list
        msgs = r.get("messages") or r.get("conversations")
        if isinstance(msgs, list) and msgs:
            sys_prompt, memory, current, final = _split_history(msgs)
            if not current or not final:
                continue
            prompt_text = current.get("content", "")
            target_text = final.get("content", "") or ""

        # Shape F: DPO triples
        elif isinstance(r.get("chosen"), str) and r.get("prompt"):
            prompt_text = str(r.get("prompt") or "")
            target_text = str(r.get("chosen") or "")

        # Shape C: workflow_json + metadata (Ker102 master)
        elif r.get("workflow_json"):
            wf_raw = r.get("workflow_json")
            target_text = wf_raw if isinstance(wf_raw, str) else json.dumps(wf_raw)
            name = (r.get("workflow_name") or "").strip()
            integrations = r.get("integrations") or ""
            category = r.get("category") or ""
            if isinstance(integrations, str) and integrations.startswith("["):
                try:
                    integrations = ", ".join(json.loads(integrations))
                except json.JSONDecodeError:
                    pass
            prompt_text = (
                f"Generate the JSON for an n8n workflow named '{name or 'untitled'}'"
                + (f" in the '{category}' category" if category else "")
                + (f" using these integrations: {integrations}" if integrations else "")
                + ". Return only the workflow JSON."
            )

        # Shape D: nodes + connections (batuhanilgarr)
        elif r.get("nodes") is not None and r.get("connections") is not None:
            nodes_v = r.get("nodes")
            conns_v = r.get("connections")
            try:
                nodes_obj = json.loads(nodes_v) if isinstance(nodes_v, str) else nodes_v
                conns_obj = json.loads(conns_v) if isinstance(conns_v, str) else conns_v
            except json.JSONDecodeError:
                continue
            wf = {"name": r.get("name") or "", "nodes": nodes_obj, "connections": conns_obj}
            prompt_text = _n8n_synth_prompt_from_workflow(wf)
            target_text = json.dumps(wf, ensure_ascii=False, separators=(",", ":"))

        # Shape E: kv (0xarchit)
        elif isinstance(r.get("key"), str) and isinstance(r.get("value"), str):
            prompt_text = r.get("key") or ""
            target_text = r.get("value") or ""

        # Shape B: prompt-completion pair
        else:
            instruction = _n8n_first_str(r, ["instruction"])
            inp = _n8n_first_str(r, ["input"])
            prompt_only = _n8n_first_str(r, ["prompt", "question", "query"])
            target_text = _n8n_first_str(
                r, ["json", "answer", "output", "completion", "response"]
            )
            if not target_text:
                continue
            if instruction and inp:
                prompt_text = f"{instruction}\n\n{inp}".strip()
            elif instruction:
                prompt_text = instruction
            elif prompt_only:
                prompt_text = prompt_only
            elif inp:
                prompt_text = inp
            else:
                continue
            t = r.get("thinking")
            if isinstance(t, str) and t.strip():
                thinking = t

        if not prompt_text or not target_text:
            continue

        # Skip workflow-analysis tasks (image→description) that get
        # mis-tagged as generation. The davidrpatton dataset is the main
        # offender — its prompts begin with `<image>` and the assistant
        # output is a prose description that happens to embed the workflow.
        if prompt_text.lstrip().startswith("<image>"):
            continue

        # Recover a real workflow object from the raw target. This collapses
        # the heterogeneous source shapes (raw JSON, fenced JSON, prose-
        # prefixed JSON, French `<thinking>` chains-of-thought) into a single
        # canonical structure we can re-emit deterministically.
        wf = _n8n_extract_workflow(target_text)
        if wf is None:
            continue

        dedup = stable_id(slug, prompt_text[:512], json.dumps(wf, sort_keys=True)[:512])
        if dedup in seen:
            continue
        seen.add(dedup)

        response = encoder.encode(_n8n_planner_target(wf))
        response_shape = "structured_envelope"
        emitted += 1

        current_msg = {
            "role": "user",
            "speaker": "user",
            "content": prompt_text,
            "channel": "dm",
        }
        md: dict[str, Any] = {
            "original_id": str(r.get("id") or r.get("workflow_id") or dedup),
            "response_shape": response_shape,
        }
        if sys_prompt:
            md["system_prompt"] = sys_prompt
        if thinking:
            md["thinking"] = thinking
        # Carry over a few useful columns when present
        for k in ("category", "complexity", "node_count", "integrations",
                  "source_url", "source_title", "workflow_name"):
            v = r.get(k)
            if v not in (None, "", []):
                md[k] = v if not isinstance(v, (dict, list)) else json.dumps(v)

        yield build(
            roomName=stable_id(slug, prompt_text[:120]),
            agentId="agent",
            memoryEntries=memory,
            currentMessage=current_msg,
            expectedResponse=response,
            availableActions=N8N_WORKFLOW_ACTIONS.copy(),
            task_type="n8n_workflow_generation",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )


# ───────────────────────── dialogue datasets (raw) ──────────────────────────

def dialogue_raw(records, *, slug, license, split, encoder):
    """Raw chat datasets (Discord/Telegram). The normalizer treats these as
    *unmolded* multi-turn corpora — we don't build supervised records here.
    Instead, the dialogue routing synthesizer reads `data/raw/<slug>/` later
    to mix conversations and label RESPOND/IGNORE turns. Yield nothing.
    """
    if False:
        yield  # type: ignore[unreachable]
    return


# ────────────────────── Facebook LIGHT / multilight ───────────────────────

# Memory window for routing/reply records (matches the multiparty synthesizer).
_LIGHT_MEMORY_WINDOW = 12
_LIGHT_PRIMARY_CONTEXT = "light-fantasy-roleplay"


def _light_has_addressing(text: str, speaker: str) -> bool:
    """Does `text` directly address `speaker`? (mention / leading vocative /
    standalone name token)."""
    if not text or not speaker:
        return False
    s = speaker.strip().lower()
    if not s or s in {"user", "human", "ai", "assistant", "bot"}:
        return False
    t = text.lower()
    if f"@{s}" in t:
        return True
    if re.search(rf"^\s*{re.escape(s)}\s*[,:?!\.]", t, re.I):
        return True
    if re.search(rf"\b{re.escape(s)}\b", t, re.I):
        return True
    return False


def _light_persona_for(characters: list[dict[str, Any]], name: str) -> str:
    for ch in characters or []:
        if (ch.get("name") or "").lower() == (name or "").lower():
            persona = (ch.get("persona") or "").strip()
            desc = (ch.get("desc") or "").strip()
            if persona and desc and persona != desc:
                return f"{persona}\n\n{desc}"
            return persona or desc
    return ""


def _light_memory_from_turns(
    turns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        {
            "role": "user",
            "speaker": (t.get("speaker") or "user")[:60],
            "content": (t.get("text") or "")[:2000],
            "channel": "public",
        }
        for t in turns
        if (t.get("text") or "").strip()
    ]


def light_multilight(records, *, slug, license, split, encoder):
    """Facebook LIGHT MultiLIGHT — multi-party fantasy text-adventure dialogues.

    Source schema (one conversation per JSONL line, produced by our preproc
    of the upstream EpisodeDB tarball):

        {
          "episode_id": "EPI-…",
          "split":      "train" | "validation" | "test",
          "location":   {"name", "description", "extra_desc"},
          "characters": [{"name", "persona", "desc"} × 3],
          "messages":   [{"speaker", "text", "timestamp"} …]
        }

    Each conversation has exactly 3 named characters speaking in turn. For
    every message at index i ≥ 1 we walk it from the perspective of the
    speaker at index i (the "agent") and emit:

      - one `should_respond_with_context` record where the latest other
        character's turn is `currentMessage` and the agent decides
        RESPOND (because it actually spoke next) — yielding a positive
        routing label.

      - one `should_respond_with_context` record from the perspective of
        each *other* character at the same point: their `currentMessage`
        is the same latest other-character turn, and their target action
        is IGNORE (they did NOT speak next). This yields negatives without
        synthesis.

      - one `reply` record for the agent that actually spoke, training the
        model to produce the exact line the corpus shows.

    All routing targets render as the canonical structured document
    `{name, reasoning, action, primaryContext, secondaryContexts,
    evidenceTurnIds}`; reply targets render as `{thought, text}`.
    """
    for r in records:
        if not isinstance(r, dict):
            continue
        messages = r.get("messages") or []
        characters = r.get("characters") or []
        if len(messages) < 2 or not characters:
            continue
        episode_id = r.get("episode_id") or stable_id(slug, json.dumps(messages[:1]))
        location = r.get("location") or {}
        location_name = (location.get("name") or "").strip()
        location_desc = (location.get("description") or "").strip()
        rec_split = r.get("split") or split or "train"

        all_speakers = [
            (ch.get("name") or "").strip()
            for ch in characters
            if (ch.get("name") or "").strip()
        ]
        if not all_speakers:
            continue

        for i in range(1, len(messages)):
            spoken = messages[i]
            actual_speaker = (spoken.get("speaker") or "").strip()
            actual_text = (spoken.get("text") or "").strip()
            if not actual_speaker or not actual_text:
                continue

            # The latest non-actual-speaker turn before i is what the agent
            # is "responding to". For multi-party we just take messages[i-1]
            # — that's the conversation as played out.
            prev = messages[i - 1]
            prev_speaker = (prev.get("speaker") or "").strip()
            prev_text = (prev.get("text") or "").strip()
            if not prev_speaker or not prev_text:
                continue

            # Skip if the previous message is from the same speaker — the
            # multiparty pattern needs a different "current" speaker.
            if prev_speaker.lower() == actual_speaker.lower():
                continue

            window_start = max(0, (i - 1) - _LIGHT_MEMORY_WINDOW)
            context_turns = messages[window_start : i - 1]

            current_msg = {
                "role": "user",
                "speaker": prev_speaker[:60],
                "content": prev_text[:2000],
                "channel": "public",
            }
            memory = _light_memory_from_turns(context_turns)

            # ------ Positive routing record (the speaker that actually spoke)
            agent_persona = _light_persona_for(characters, actual_speaker)
            addressed = _light_has_addressing(prev_text, actual_speaker)
            reasoning = (
                f"{actual_speaker} is named/addressed in the prior turn, so "
                "they should reply."
                if addressed
                else f"It is {actual_speaker}'s turn in the conversation, so "
                "they should reply."
            )
            target = {
                "name": actual_speaker,
                "reasoning": reasoning,
                "action": ACTION_RESPOND,
                "primaryContext": _LIGHT_PRIMARY_CONTEXT,
                "secondaryContexts": location_name,
                "evidenceTurnIds": "",
            }
            md_routing: dict[str, Any] = {
                "episode_id": episode_id,
                "agent_name": actual_speaker,
                "synth_target_action": ACTION_RESPOND,
                "task_type_handler": "should_respond",
                "addressed_by_name": addressed,
                "location_name": location_name,
                "num_speakers": len(all_speakers),
            }
            if agent_persona:
                md_routing["persona"] = agent_persona
            if location_desc:
                md_routing["location_description"] = location_desc[:500]

            yield build(
                roomName=stable_id(slug, episode_id, i, "respond", actual_speaker),
                agentId=actual_speaker.lower(),
                memoryEntries=memory,
                currentMessage=current_msg,
                expectedResponse=encoder.encode(target),
                availableActions=ROUTING_ACTIONS.copy(),
                task_type="should_respond_with_context",
                source_dataset=slug,
                license=license,
                split=rec_split,
                extra_metadata=md_routing,
            )

            # ------ Negative routing records: each other named character
            # who did NOT speak at turn i. Ground-truth IGNORE label.
            for other in all_speakers:
                if other.lower() == actual_speaker.lower():
                    continue
                if other.lower() == prev_speaker.lower():
                    # The prior speaker isn't expected to immediately respond
                    # to themselves; conventionally we still yield this as
                    # IGNORE, but skip to keep records cleaner — they just
                    # spoke.
                    continue
                other_persona = _light_persona_for(characters, other)
                other_addressed = _light_has_addressing(prev_text, other)
                other_reasoning = (
                    f"{other} is not named or addressed in the prior turn, "
                    f"and {actual_speaker} is the one taking the turn."
                    if not other_addressed
                    else f"Although {other} could plausibly speak, "
                    f"{actual_speaker} takes this turn instead."
                )
                neg_target = {
                    "name": other,
                    "reasoning": other_reasoning,
                    "action": ACTION_IGNORE,
                    "primaryContext": _LIGHT_PRIMARY_CONTEXT,
                    "secondaryContexts": location_name,
                    "evidenceTurnIds": "",
                }
                md_neg: dict[str, Any] = {
                    "episode_id": episode_id,
                    "agent_name": other,
                    "synth_target_action": ACTION_IGNORE,
                    "task_type_handler": "should_respond",
                    "addressed_by_name": other_addressed,
                    "location_name": location_name,
                    "num_speakers": len(all_speakers),
                    "actual_speaker": actual_speaker,
                }
                if other_persona:
                    md_neg["persona"] = other_persona
                if location_desc:
                    md_neg["location_description"] = location_desc[:500]

                yield build(
                    roomName=stable_id(slug, episode_id, i, "ignore", other),
                    agentId=other.lower(),
                    memoryEntries=memory,
                    currentMessage=current_msg,
                    expectedResponse=encoder.encode(neg_target),
                    availableActions=ROUTING_ACTIONS.copy(),
                    task_type="should_respond_with_context",
                    source_dataset=slug,
                    license=license,
                    split=rec_split,
                    extra_metadata=md_neg,
                )

            # ------ Reply record for the agent that actually spoke. The
            # supervised target is `{thought, text}` rendered with the configured expected-response encoder.
            reply_target = {
                "thought": (
                    f"As {actual_speaker}, I respond to {prev_speaker} in "
                    f"{location_name}." if location_name
                    else f"As {actual_speaker}, I respond to {prev_speaker}."
                ),
                "text": actual_text,
            }
            md_reply: dict[str, Any] = {
                "episode_id": episode_id,
                "agent_name": actual_speaker,
                "task_type_handler": "reply",
                "location_name": location_name,
                "num_speakers": len(all_speakers),
            }
            if agent_persona:
                md_reply["persona"] = agent_persona
            if location_desc:
                md_reply["location_description"] = location_desc[:500]

            yield build(
                roomName=stable_id(slug, episode_id, i, "reply", actual_speaker),
                agentId=actual_speaker.lower(),
                memoryEntries=memory,
                currentMessage=current_msg,
                expectedResponse=encoder.encode(reply_target),
                availableActions=REPLY_ACTIONS.copy(),
                task_type="reply",
                source_dataset=slug,
                license=license,
                split=rec_split,
                extra_metadata=md_reply,
            )


# ──────────────────────────── claude distillation ──────────────────────────


# System prompt used for Claude-distilled records when the upstream `system`
# turn is empty (which is the common case in `Kassadin88/Claude-Distills`).
# The wording is intentionally minimal — we want the model to learn the
# `<think>...</think>final` shape from the data, not to memorize a long
# header. When the upstream record DOES carry a system message, we use it
# verbatim instead.
CLAUDE_DISTILL_SYSTEM = (
    "You are a helpful, careful assistant. Think step by step inside "
    "<think>...</think> tags before producing your final answer."
)


def claude_distill(records: Iterator[dict], *, slug: str, license: str,
                   split: str, encoder: ExpectedResponseEncoder) -> Iterator[ElizaRecord]:
    """Adapter for Kassadin88/Claude-Distills (and similarly-shaped distill
    corpora). Each record is `{messages: [system?, user, assistant], source}`
    and the assistant content already contains
    `<think>{reasoning}</think>{final answer}`.

    We preserve the assistant content **verbatim** in `expectedResponse`
    (no TOON re-encoding) so the student model learns the exact `<think>`
    surface that Qwen3.6 / Qwopus and our generation pipeline both expect.

    The `messages` array is rendered into `memoryEntries` + `currentMessage`
    + `expectedResponse` so `tokenizer.apply_chat_template(...)` produces
    a chat that is byte-uniform with the upstream distill.
    """

    for r in records:
        msgs = r.get("messages") or []
        if not isinstance(msgs, list) or not msgs:
            continue

        system_parts: list[str] = []
        convo: list[dict[str, Any]] = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = _norm_role(m.get("role") or "")
            content = m.get("content") or ""
            if isinstance(content, list):
                content = "".join(
                    p.get("text", "") if isinstance(p, dict) else str(p)
                    for p in content
                )
            content = _strip_surrogates(str(content))
            if role == "system":
                if content.strip():
                    system_parts.append(content)
                continue
            if role not in ("user", "assistant"):
                continue
            convo.append({"role": role, "content": content})

        # Need at least one user turn and one assistant turn — the supervised
        # target is the final assistant turn.
        final_assistant = None
        for i in range(len(convo) - 1, -1, -1):
            if convo[i]["role"] == "assistant":
                final_assistant = convo[i]
                final_idx = i
                break
        if final_assistant is None or not (final_assistant["content"] or "").strip():
            continue
        prior = convo[:final_idx]

        current = None
        for m in reversed(prior):
            if m["role"] == "user" and (m["content"] or "").strip():
                current = {
                    "role": "user", "speaker": "user",
                    "content": m["content"], "channel": "dm",
                }
                prior.remove(m)
                break
        if current is None:
            continue

        memory = [
            {"role": m["role"], "speaker": m["role"],
             "content": m["content"], "channel": "dm"}
            for m in prior
        ]

        sys_prompt = "\n\n".join(system_parts).strip() or CLAUDE_DISTILL_SYSTEM
        source = str(r.get("source") or "")

        md = {
            "system_prompt": sys_prompt,
            "claude_source": source,
            "preserve_think_tags": True,
        }

        seed = current["content"][:160] + "|" + (final_assistant["content"][:80])
        yield build(
            roomName=stable_id(slug, source, seed),
            agentId="assistant",
            memoryEntries=memory,
            currentMessage=current,
            # Verbatim — no TOON re-encoding. The `<think>...</think>final`
            # surface ships through `tokenizer.apply_chat_template` exactly
            # as the distill source recorded it.
            expectedResponse=final_assistant["content"],
            # Intentionally empty — Claude distills are general-purpose Q&A,
            # not elizaOS action routing. Empty list prevents the
            # "Available actions: ..." suffix from being appended to the
            # system prompt by format_for_training.py.
            availableActions=[],
            task_type="claude_distill",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )


# ────────────────── abliteration calibration corpora ─────────────────────
#
# These adapters consume `mlabonne/harmful_behaviors` and
# `mlabonne/harmless_alpaca` (or any equivalent benign-instruction set).
# The output is NOT a supervised target — it's calibration data for the
# orthogonal-projection refusal-direction ablation in
# `scripts/quantization/abliteration_apply.py`. The downstream consumer
# only reads `currentMessage.content`; `expectedResponse` carries a
# sentinel so `ElizaRecord.is_valid()` accepts the row.
#
# `pack_dataset.py` filters records with task_type in
# {"abliteration_harmful","abliteration_harmless"} out of train/val/test
# and writes them to `data/abliteration/{harmful,harmless}.jsonl`.

_ABLITERATION_PROMPT_KEYS = (
    "prompt", "goal", "instruction", "text", "behavior", "input", "question",
)
_ABLITERATION_SENTINEL = "<abliteration-calibration>"


def _abliteration_prompt(rec: dict[str, Any]) -> str:
    for key in _ABLITERATION_PROMPT_KEYS:
        val = rec.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    msgs = rec.get("messages") or rec.get("conversations")
    if isinstance(msgs, list):
        for m in msgs:
            if not isinstance(m, dict):
                continue
            if _norm_role(str(m.get("role") or m.get("from") or "")) == "user":
                content = m.get("content") or m.get("value") or ""
                if isinstance(content, str) and content.strip():
                    return content.strip()
    return ""


def _abliteration_yield(
    records, *, slug, license, split, task_type, channel,
):
    for r in records:
        if not isinstance(r, dict):
            continue
        prompt = _abliteration_prompt(r)
        if not prompt:
            continue
        prompt = _strip_surrogates(prompt)[:4000]
        yield build(
            roomName=stable_id(slug, task_type, prompt[:160]),
            agentId="calibration",
            currentMessage={
                "role": "user", "speaker": "user",
                "content": prompt, "channel": channel,
            },
            expectedResponse=_ABLITERATION_SENTINEL,
            availableActions=[],
            task_type=task_type,
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata={"abliteration_calibration": True},
        )


def harmful_behaviors(records, *, slug, license, split, encoder):
    """mlabonne/harmful_behaviors — refusal-eliciting prompts. Calibration
    only: emits ElizaRecord with task_type=abliteration_harmful and a
    sentinel expectedResponse. Routed to data/abliteration/harmful.jsonl
    by pack_dataset.py (weight=0.0 in datasets.yaml)."""
    yield from _abliteration_yield(
        records, slug=slug, license=license, split=split,
        task_type="abliteration_harmful", channel="abliteration",
    )


def harmless_alpaca(records, *, slug, license, split, encoder):
    """mlabonne/harmless_alpaca — paired benign instructions for
    orthogonal-projection abliteration. Calibration only: emits
    ElizaRecord with task_type=abliteration_harmless and a sentinel
    expectedResponse. Routed to data/abliteration/harmless.jsonl by
    pack_dataset.py (weight=0.0 in datasets.yaml)."""
    yield from _abliteration_yield(
        records, slug=slug, license=license, split=split,
        task_type="abliteration_harmless", channel="abliteration",
    )


# ──────────────────────────────── registry ─────────────────────────────────

REGISTRY: dict[str, Adapter] = {
    # core / canonical
    "scambench_passthrough": scambench_passthrough,
    # tool calling
    "hermes_fc": hermes_fc,
    "hermes_fc_thinking": hermes_fc_thinking,
    "glaive_fc": glaive_fc,
    "glaive_fc_reasoning": glaive_fc_reasoning,
    "sharegpt_tool_calls": sharegpt_tool_calls,
    "functions_53k": functions_53k,
    "bitagent": bitagent,
    "toolhop": toolhop,
    # operator / mobile
    "openclaw_operator": openclaw_operator,
    "mobile_actions": mobile_actions,
    # agentic / hermes traces
    "nemotron_rl_tool_use": nemotron_rl_tool_use,
    "qwen36_trajectory": qwen36_trajectory,
    "hermes_reasoning_tool_use": hermes_reasoning_tool_use,
    "dolci_instruct": dolci_instruct,
    "hermes_traces": hermes_traces,
    "hermes_omniforge": hermes_omniforge,
    "hermes_3": hermes_3,
    "aureth": aureth,
    "nemotron_coding_reasoning": nemotron_coding_reasoning,
    "hf_coding_tools_traces": hf_coding_tools_traces,
    "chatml_text": chatml_text,
    "gemma_text": gemma_text,
    "open_paws_llama": open_paws_llama,
    "noesis_text": noesis_text,
    # MCP
    "mcp_messages": mcp_messages,
    "mcp_routing": mcp_routing,
    "mcp_flow": mcp_flow,
    # shell / terminal / agent trajectories
    "terminal_corpus": terminal_corpus,
    "agent_trove": agent_trove,
    # reasoning / CoT
    "reasoning_cot": reasoning_cot,
    # raw dialogue (consumed by synthesize_routing.py)
    "dialogue_raw": dialogue_raw,
    # multi-party fantasy roleplay (Facebook LIGHT MultiLIGHT)
    "light_multilight": light_multilight,
    # local milady corpora
    "nubilio_trajectories": nubilio_trajectories,
    "scam_defense_corpus": scam_defense_corpus,
    # n8n workflow generation
    "n8n_workflow": n8n_workflow,
    # Claude distillation (Kassadin88/Claude-Distills) — preserves
    # <think>…</think>final-answer in expectedResponse verbatim.
    "claude_distill": claude_distill,
    # Abliteration calibration corpora (NOT in train mix; weight=0.0).
    # pack_dataset.py routes these to data/abliteration/{harmful,harmless}.jsonl.
    "harmful_behaviors": harmful_behaviors,
    "harmless_alpaca": harmless_alpaca,
}
