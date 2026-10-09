"""Legacy corpus adapters: mcp."""

from __future__ import annotations
import json
import re
from typing import Any, Iterator
from ..eliza_record import (
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_TASKS,
    ElizaRecord,
    REPLY_ACTIONS,
    build,
    stable_id,
)
from ..expected_response import ExpectedResponseEncoder
from .common import (
    _build_messages_record,
    _cot_to_expected,
    _extract_tool_calls,
    _generic_messages,
    _normalize_messages,
    _normalize_tools,
    _planner_tool_envelope,
    _split_per_turn,
)

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
       assistant turn lands as structured ``tool_calls`` when it carries an
       OpenAI-compatible tool call. Otherwise it lands as structured output
       ``{thought, text}`` for text replies. This recovers tool calls
       that live in the middle of agent traces (deepfabric-github-mcp,
       playwright-mcp-toolcalling) instead of dropping them in favor of
       the final text turn.

    2. **Alpaca with phi3-mcp DSL** (``instruction``/``input``/``output``
       where ``output`` is ``TOOL_NEEDED: <name>\\nPARAMS: <json>``).
       Tool calls land as structured ``tool_calls`` with the reason in
       ``metadata.tool_reason``; non-tool replies land as structured output
       ``{thought, text}``.

    3. **Generic Alpaca** (``instruction``/``input``/``output``). Plain
       text outputs remain replies; tool-call rows must carry structured
       fields in the source.
    """
    for r in records:
        msgs = (
            r.get("messages")
            or r.get("conversations")
            or r.get("chat")
            or r.get("trajectory")
            or []
        )
        if msgs:
            yield from _mcp_multi_turn(
                r,
                msgs,
                slug=slug,
                license=license,
                split=split,
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
            target = encoder.encode(
                _planner_tool_envelope(
                    thought=reason,
                    tool_calls=[call],
                    providers=[],
                )
            )
            actions = [ACTION_TASKS, ACTION_REPLY, ACTION_IGNORE]
            tt = "tool_call"
            md: dict[str, Any] = {
                "original_id": str(r.get("id") or ""),
                "expected_tool_calls": [call],
            }
            if reason:
                md["tool_reason"] = reason
            yield build(
                roomName=stable_id(slug, prompt),
                agentId="mcp-agent",
                currentMessage={
                    "role": "user",
                    "speaker": "user",
                    "content": prompt,
                    "channel": "dm",
                },
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
            target = encoder.encode(
                _planner_tool_envelope(
                    thought="",
                    tool_calls=calls,
                    providers=[],
                )
            )
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
            roomName=stable_id(slug, prompt),
            agentId="mcp-agent",
            currentMessage={
                "role": "user",
                "speaker": "user",
                "content": prompt,
                "channel": "dm",
            },
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
    r: dict[str, Any],
    msgs_raw: Any,
    *,
    slug: str,
    license: str,
    split: str,
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
            slug=slug,
            license=license,
            split=split,
            sys_prompt=sys_prompt,
            memory=memory,
            current=current,
            assistant=assistant,
            encoder=encoder,
            tools_list=tools_list,
            default_task_type="mcp_tool_call",
            extra_metadata=extra,
            room_seed=f"{base_id}#{idx}" if base_id else f"{current['content']}#{idx}",
        )


def mcp_routing(records, *, slug, license, split, encoder):
    for r in records:
        if isinstance(r.get("messages"), list) or isinstance(
            r.get("conversations"), list
        ):
            yield from _generic_messages(
                iter([r]),
                slug=slug,
                license=license,
                split=split,
                messages_key=lambda x: (
                    x.get("messages") or x.get("conversations") or []
                ),
                encoder=encoder,
                default_task_type="mcp_tool_call",
                tools_key="tools",
            )
            continue
        query = r.get("query") or r.get("input") or r.get("instruction") or ""
        if not query:
            continue
        target = {
            "server": r.get("server")
            or r.get("mcp_server")
            or r.get("expected_server")
            or "",
            "tool": r.get("tool") or r.get("expected_tool") or "",
            "arguments": r.get("arguments") or r.get("params") or {},
        }
        expected_response = encoder.encode(target)
        yield build(
            roomName=stable_id(slug, r.get("id") or query[:120]),
            agentId="mcp-router",
            currentMessage={
                "role": "user",
                "speaker": "user",
                "content": query,
                "channel": "dm",
            },
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
            expected_response = encoder.encode(
                _planner_tool_envelope(
                    thought="",
                    tool_calls=calls,
                    providers=[],
                )
            )
            yield build(
                roomName=stable_id(slug, call["name"], user_q[:80]),
                agentId="mcp-agent",
                currentMessage={
                    "role": "user",
                    "speaker": "user",
                    "content": user_q,
                    "channel": "dm",
                },
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
            expected_response = encoder.encode(
                _planner_tool_envelope(
                    thought="",
                    tool_calls=calls,
                    providers=[],
                )
            )
            yield build(
                roomName=stable_id(slug, call["name"], user_q[:80]),
                agentId="mcp-agent",
                currentMessage={
                    "role": "user",
                    "speaker": "user",
                    "content": user_q,
                    "channel": "dm",
                },
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
