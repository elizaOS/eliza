"""Legacy corpus adapters: chat."""

from __future__ import annotations
import json
import re
from typing import Any
from .common import _generic_messages
from .mcp import _mcp_multi_turn

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
            slug=slug,
            license=license,
            split=split,
            messages_key="messages",
            encoder=encoder,
            default_task_type="reasoning_cot",
        )


_GEMMA_RE = re.compile(
    r"<start_of_turn>\s*(\w+)\s*(.*?)<end_of_turn>",
    re.DOTALL,
)

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
        v = p[colon + 1 :].strip()
        if v.startswith(_HA_ESCAPE) and v.endswith(_HA_ESCAPE):
            args[k] = v[len(_HA_ESCAPE) : -len(_HA_ESCAPE)]
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
        calls.append(
            {
                "name": m.group(1),
                "arguments": _parse_ha_mcp_args(m.group(2)),
            }
        )
    thought = ""
    tm = _HA_THINK_RE.search(content)
    if tm:
        thought = tm.group(1).strip()
    trailing = ""
    end_tag = content.rfind("<end_function_response>")
    if end_tag >= 0:
        trailing = content[end_tag + len("<end_function_response>") :].strip()
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
            slug=slug,
            license=license,
            split=split,
            encoder=encoder,
        )


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
                    tool_calls.append(
                        {
                            "type": "function",
                            "function": {
                                "name": parsed["name"],
                                "arguments": json.dumps(parsed["arguments"]),
                            },
                        }
                    )
            if tool_calls:
                msg["content"] = head.strip()
                msg["tool_calls"] = tool_calls
        msgs.append(msg)
    return msgs


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
        role = (
            "user"
            if role_raw in ("user", "human")
            else ("assistant" if role_raw == "assistant" else "system")
        )
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        content = text[start:end].strip()
        if not content:
            continue
        msgs.append({"role": role, "content": content})
    return msgs


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
        is_reasoning = "<think>" in text or domain in (
            "reasoning",
            "code",
            "math",
            "science",
            "stem",
        )
        default_tt = "reasoning_cot" if is_reasoning else "reply"
        yield from _generic_messages(
            iter([{"messages": msgs}]),
            slug=slug,
            license=license,
            split=split,
            messages_key="messages",
            encoder=encoder,
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
            slug=slug,
            license=license,
            split=split,
            messages_key="messages",
            encoder=encoder,
            default_task_type="reply",
        )
