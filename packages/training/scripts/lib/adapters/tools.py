"""Legacy corpus adapters: tools."""

from __future__ import annotations
import json
import re
from typing import Any
from ..eliza_record import (
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_TASKS,
    REPLY_ACTIONS,
    build,
    stable_id,
)
from .common import (
    _cot_to_expected,
    _generic_messages,
    _normalize_tools,
    _planner_ignore_envelope,
    _planner_reply_envelope,
    _planner_tool_envelope,
)

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
                text=text,
                providers=[],
                seed=text,
            )
        expected_response = encoder.encode(target)
        yield build(
            roomName=r.get("roomName", "")
            or stable_id(slug, r.get("currentMessage", {}).get("content", "")),
            agentId=r.get("agentId", "scam-defense-agent"),
            memoryEntries=r.get("memoryEntries") or [],
            currentMessage=r.get("currentMessage") or {},
            expectedResponse=expected_response,
            availableActions=_normalize_scam_actions(r.get("availableActions") or []),
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
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key="conversations",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def hermes_fc_thinking(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key="conversations",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def glaive_fc(records, *, slug, license, split, encoder):
    """Glaive function-calling v2 — `chat` is a single string with role markers.

    The `-reasoning` shard ships an extra `processed_chat_with_reasoning`
    field where each ASSISTANT turn is prefixed with `<think>...</think>`;
    we prefer it when present so `_cot_to_expected` can lift the reasoning
    into `thought:` instead of dropping it.
    """
    for r in records:
        if isinstance(r.get("messages"), list):
            yield from _generic_messages(
                iter([r]),
                slug=slug,
                license=license,
                split=split,
                messages_key="messages",
                encoder=encoder,
                default_task_type="tool_call",
                tools_key="tools",
            )
            continue
        chat = r.get("processed_chat_with_reasoning") or r.get("chat") or ""
        sys_prompt = r.get("system") or ""
        parts = re.split(
            r"(USER:|ASSISTANT:|FUNCTION RESPONSE:|SYSTEM:|A:|FUNCTION CALL:|FUNCTION RESULT:)",
            chat,
        )
        msgs: list[dict[str, Any]] = []
        i = 1
        while i < len(parts) - 1:
            marker, content = parts[i], parts[i + 1].strip()
            role = {
                "USER:": "user",
                "ASSISTANT:": "assistant",
                "A:": "assistant",
                "FUNCTION RESPONSE:": "tool",
                "FUNCTION RESULT:": "tool",
                "FUNCTION CALL:": "assistant",
                "SYSTEM:": "system",
            }.get(marker, "user")
            msgs.append({"role": role, "content": content})
            i += 2
        if sys_prompt:
            msgs.insert(0, {"role": "system", "content": sys_prompt})
        if not msgs:
            continue
        yield from _generic_messages(
            iter([{"messages": msgs, "tools": r.get("tools")}]),
            slug=slug,
            license=license,
            split=split,
            messages_key="messages",
            encoder=encoder,
            default_task_type="tool_call",
            tools_key="tools",
        )


def glaive_fc_reasoning(records, *, slug, license, split, encoder):
    return glaive_fc(records, slug=slug, license=license, split=split, encoder=encoder)


def sharegpt_tool_calls(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key="conversations",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def functions_53k(records, *, slug, license, split, encoder):
    for r in records:
        if isinstance(r.get("messages"), list):
            yield from _generic_messages(
                iter([r]),
                slug=slug,
                license=license,
                split=split,
                messages_key="messages",
                encoder=encoder,
                default_task_type="tool_call",
                tools_key="functions",
            )
            continue
        prompt = r.get("prompt") or r.get("input") or ""
        completion = r.get("completion") or r.get("output") or ""
        if not prompt or not completion:
            continue
        calls: list[dict[str, Any]] = []
        try:
            parsed = (
                json.loads(completion) if isinstance(completion, str) else completion
            )
            if isinstance(parsed, dict) and "name" in parsed:
                calls = [
                    {"name": parsed["name"], "arguments": parsed.get("arguments") or {}}
                ]
            elif isinstance(parsed, list):
                calls = [
                    {"name": p.get("name", ""), "arguments": p.get("arguments") or {}}
                    for p in parsed
                    if isinstance(p, dict)
                ]
        except (json.JSONDecodeError, TypeError):
            pass
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
        else:
            target = _cot_to_expected(encoder, str(completion))
            actions = REPLY_ACTIONS.copy()
            tt = "reply"
        yield build(
            roomName=stable_id(slug, r.get("id") or prompt),
            agentId="agent",
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
                normalized.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": str(
                                        content.get("name")
                                        or content.get("tool")
                                        or content.get("tool_name")
                                        or ""
                                    ),
                                    "arguments": json.dumps(
                                        content.get("arguments")
                                        or content.get("args")
                                        or {}
                                    ),
                                },
                            }
                        ],
                    }
                )
            elif role in ("tool response", "tool"):
                normalized.append({"role": "tool", "content": str(content)})
            else:
                normalized.append(
                    {
                        "role": role,
                        "content": str(content) if content is not None else "",
                    }
                )
        return {"messages": normalized, "tools": r.get("tools")}

    yield from _generic_messages(
        (_normalize(r) for r in records),
        slug=slug,
        license=license,
        split=split,
        messages_key="messages",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
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
            currentMessage={
                "role": "user",
                "speaker": "user",
                "content": question,
                "channel": "dm",
            },
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
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key="messages",
        encoder=encoder,
        default_task_type="agent_trace",
        tools_key="tools",
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
        _retag(records),
        slug=slug,
        license=license,
        split=split,
        messages_key="messages",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
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
            msgs = list(msgs) + [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": ea.get("name", ""),
                                "arguments": json.dumps(
                                    ea.get("arguments") or ea.get("args") or {}
                                ),
                            },
                        }
                    ],
                }
            ]
        return {"messages": msgs, "tools": tools, "id": r.get("trajectory_id")}

    yield from _generic_messages(
        (_normalize(r) for r in records),
        slug=slug,
        license=license,
        split=split,
        messages_key="messages",
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def qwen36_trajectory(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key=lambda r: (
            r.get("messages") or r.get("conversations") or r.get("trajectory") or []
        ),
        encoder=encoder,
        default_task_type="agent_trace",
        tools_key="tools",
    )


def hermes_reasoning_tool_use(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key=lambda r: r.get("conversations") or r.get("messages") or [],
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def dolci_instruct(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key=lambda r: r.get("messages") or r.get("conversations") or [],
        encoder=encoder,
        default_task_type="tool_call",
        tools_key="tools",
    )


def hermes_traces(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key=lambda r: (
            r.get("conversations") or r.get("messages") or r.get("trajectory") or []
        ),
        encoder=encoder,
        default_task_type="agent_trace",
        tools_key="tools",
    )


def hermes_omniforge(records, *, slug, license, split, encoder):
    return hermes_traces(
        records, slug=slug, license=license, split=split, encoder=encoder
    )


def hermes_3(records, *, slug, license, split, encoder):
    return _generic_messages(
        records,
        slug=slug,
        license=license,
        split=split,
        messages_key=lambda r: r.get("conversations") or r.get("messages") or [],
        encoder=encoder,
        default_task_type="agent_trace",
        tools_key="tools",
    )


def aureth(records, *, slug, license, split, encoder):
    return hermes_traces(
        records, slug=slug, license=license, split=split, encoder=encoder
    )


def nemotron_coding_reasoning(records, *, slug, license, split, encoder):
    return hermes_traces(
        records, slug=slug, license=license, split=split, encoder=encoder
    )


def hf_coding_tools_traces(records, *, slug, license, split, encoder):
    return hermes_traces(
        records, slug=slug, license=license, split=split, encoder=encoder
    )
