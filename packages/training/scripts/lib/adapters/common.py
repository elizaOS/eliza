"""Legacy corpus adapters: common."""

from __future__ import annotations
import hashlib
import json
import logging
import re
from typing import Any, Callable, Iterator
from ..eliza_record import (
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_SHELL,
    ACTION_TASKS,
    DEFAULT_THOUGHT_LEAKS,
    ElizaRecord,
    REPLY_ACTIONS,
    build,
    is_default_thought_leak,
    stable_id,
)
from ..expected_response import ExpectedResponseEncoder


log = logging.getLogger("adapter")

assert "Reply to the user." in DEFAULT_THOUGHT_LEAKS

assert "Call the tool to satisfy the request." in DEFAULT_THOUGHT_LEAKS

Adapter = Callable[..., Iterator[ElizaRecord]]

ROLE_MAP = {
    "user": "user",
    "human": "user",
    "USER": "user",
    "question": "user",
    "assistant": "assistant",
    "gpt": "assistant",
    "model": "assistant",
    "ai": "assistant",
    "ASSISTANT": "assistant",
    "answer": "assistant",
    "response": "assistant",
    "agent": "assistant",
    "bot": "assistant",
    "system": "system",
    "SYSTEM": "system",
    "developer": "system",
    "tool": "tool",
    "function": "tool",
    "tool_response": "tool",
    "observation": "tool",
    "tool_result": "tool",
    "function_response": "tool",
    "tool call": "assistant",
    "tool_call": "assistant",
    # Some sources (regularizer-reasoning-tool) ship a separate
    # "reasoning" role that PRECEDES the corresponding assistant turn.
    # We tag it explicitly here so `_split_history` can attach it as the
    # `thought` of the next assistant turn rather than dropping it.
    "reasoning": "reasoning",
    "thought": "reasoning",
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


def _split_history(
    messages: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
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
                p.get("text", "") if isinstance(p, dict) else str(p) for p in content
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
            joined = "\n\n".join(
                [t for t in [existing, *pending_thoughts] if t]
            ).strip()
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


def _extract_tool_calls(assistant: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull tool calls from an assistant turn.

    Recognized formats (in order):
      1. OpenAI ``tool_calls`` array on the raw message.
      2. OpenAI legacy ``function_call`` object on the raw message.
      3. JSON content with ``tool_calls`` / ``toolCalls`` fields.
    """
    raw = assistant.get("raw") or {}
    content = assistant.get("content") or ""

    def normalize_one(tc: Any) -> dict[str, Any] | None:
        if not isinstance(tc, dict):
            return None
        fn = tc.get("function") or {}
        if not isinstance(fn, dict):
            fn = {}
        args = (
            tc.get("arguments")
            if "arguments" in tc
            else tc.get("args")
            if "args" in tc
            else tc.get("input")
            if "input" in tc
            else fn.get("arguments")
        )
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                pass
        name = (
            tc.get("name")
            or tc.get("tool_name")
            or tc.get("toolName")
            or fn.get("name")
        )
        if not isinstance(name, str) or not name.strip():
            return None
        return {
            "name": name.strip(),
            "arguments": args if isinstance(args, dict) else {},
        }

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
    for tc in raw_calls or []:
        normalized = normalize_one(tc)
        if normalized:
            parsed.append(normalized)

    if not parsed and isinstance(raw.get("function_call"), dict):
        normalized = normalize_one({"function": raw["function_call"]})
        if normalized:
            parsed.append(normalized)

    if not parsed and isinstance(content, str):
        body = content.strip()
        if body.startswith("{") and body.endswith("}"):
            try:
                obj = json.loads(body)
            except json.JSONDecodeError:
                obj = {}
            if isinstance(obj, dict):
                calls = obj.get("tool_calls") or obj.get("toolCalls")
                if isinstance(calls, list):
                    parsed.extend(
                        normalized
                        for call in calls
                        if (normalized := normalize_one(call))
                    )
                else:
                    normalized = normalize_one(obj)
                    if normalized:
                        parsed.append(normalized)

    return parsed


_THINK_RE = re.compile(r"<think>([\s\S]*?)</think>\s*", re.M)

_THINKING_RE = re.compile(r"<thinking>([\s\S]*?)</thinking>\s*", re.M)

_THOUGHT_PREFIX_RE = re.compile(r"^\s*THOUGHT:\s*([\s\S]*?)(?=\n\s*```|\Z)", re.M)


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
        return m.group(1).strip(), text[m.end() :].strip()
    m = _THINKING_RE.match(text)
    if m:
        return m.group(1).strip(), text[m.end() :].strip()
    m = _THOUGHT_PREFIX_RE.match(text)
    if m:
        thought = m.group(1).strip()
        if thought:
            rest = text[m.end() :].lstrip("\n")
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
    OR when `extra_thought` is supplied. Native v5 encodes that object as JSON.
    """
    thought, body = _split_thought_and_body(raw_text or "")
    if extra_thought:
        thought = (
            extra_thought.strip() + ("\n\n" + thought if thought else "")
        ).strip()
    body = _strip_surrogates(body)
    thought = _strip_surrogates(thought)
    if thought:
        return encoder.encode({"thought": thought, "text": body})
    return encoder.encode({"text": body})


_PLANNER_REPLY_TASK_TYPES = frozenset(
    {
        "agent_trace",
        "mobile_action",
        "shell_command",
        "n8n_workflow_generation",
    }
)

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
    *,
    thought: str,
    text: str,
    providers: list[str] | None = None,
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
        actions.append(
            {
                "name": action_name,
                "params": {
                    "tool": _strip_surrogates(name),
                    "arguments": args,
                },
            }
        )
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
    *,
    thought: str,
    text: str = "",
    seed: str = "",
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
            out.append(
                {
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters") or {},
                }
            )
        else:
            out.append(
                {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters") or {},
                }
            )
    return out


def _build_messages_record(
    *,
    slug: str,
    license: str,
    split: str,
    sys_prompt: str,
    memory: list[dict[str, Any]],
    current: dict[str, Any],
    assistant: dict[str, Any],
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
        thought = (
            extra_thought.strip() + ("\n\n" + thought if thought else "")
        ).strip()

    if calls:
        # Tool / MCP call → planner envelope with TASKS action(s).
        # PIPELINE_SCHEMAS.md §1+§5 — every tool_call record is wrapped in the
        # planner 5-key document so the supervised target matches the runtime
        # planner stage exactly.
        task_type = (
            "mcp_tool_call" if default_task_type == "mcp_tool_call" else "tool_call"
        )
        actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
        target = encoder.encode(
            _planner_tool_envelope(
                thought=thought,
                tool_calls=calls,
                text=body,
                providers=[],
            )
        )
    elif default_task_type in _PLANNER_REPLY_TASK_TYPES:
        # Free-text reply on a planner-typed task (agent_trace, mobile_action,
        # …) → full planner envelope with REPLY action so the schema audit
        # passes (PIPELINE_SCHEMAS.md §1).
        task_type = default_task_type
        actions = REPLY_ACTIONS.copy()
        target = encoder.encode(
            _planner_reply_envelope(
                thought=thought,
                text=body,
                providers=[],
            )
        )
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
        "original_id": str(
            extra_metadata.get("original_id", "") if extra_metadata else ""
        ),
    }
    if sys_prompt:
        md["system_prompt"] = sys_prompt
    if tools_list:
        md["toolSpecs"] = tools_list
    if calls:
        md["expected_tool_calls"] = calls
    if extra_metadata:
        md.update(extra_metadata)

    # The flat ElizaRecord currentMessage carries one of {user, assistant}.
    # When the supervised assistant turn is replying to a tool result,
    # `_split_per_turn` hands us a `tool`-role `current`; surface that result
    # as a user-side turn (which is exactly how format_for_training renders
    # currentMessage anyway) so the row matches the runtime message model.
    if current.get("role") not in ("user", "assistant"):
        current = {**current, "role": "user", "speaker": "user"}

    seed = room_seed or current["content"]
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
    records: Iterator[dict],
    *,
    slug: str,
    license: str,
    split: str,
    messages_key: str | Callable[[dict], list[dict]],
    encoder: ExpectedResponseEncoder,
    default_task_type: str = "reply",
    tools_key: str | None = None,
) -> Iterator[ElizaRecord]:
    """Generic ShareGPT/OpenAI-messages adapter."""
    for r in records:
        msgs = (
            messages_key(r) if callable(messages_key) else r.get(messages_key)
        ) or []
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
            slug=slug,
            license=license,
            split=split,
            sys_prompt=sys_prompt,
            memory=memory,
            current=current,
            assistant=final,
            encoder=encoder,
            tools_list=tools_list,
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


def _split_per_turn(
    messages: list[dict[str, Any]],
) -> tuple[str, list[tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]]]:
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
                p.get("text", "") if isinstance(p, dict) else str(p) for p in content
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
            joined = "\n\n".join(
                [t for t in [existing, *pending_thoughts] if t]
            ).strip()
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
