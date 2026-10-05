"""Legacy corpus adapters: trajectories."""

from __future__ import annotations
import json
import re
from typing import Any
from ..eliza_record import (
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_SHELL,
    ACTION_TASKS,
    REPLY_ACTIONS,
    ROUTING_ACTIONS,
    build,
    stable_id,
)
from .common import (
    _THINK_RE,
    _build_messages_record,
    _cot_to_expected,
    _extract_tool_calls,
    _normalize_tools,
    _planner_shell_envelope,
    _planner_tool_envelope,
    _split_history,
    _split_thought_and_body,
    _strip_surrogates,
)


def _shell_target(command: str, explanation: str = "", cwd: str = "") -> dict[str, Any]:
    """Build a SHELL planner-envelope target.

    Returns the canonical 5-key planner envelope (PIPELINE_SCHEMAS.md §1+§7)
    with `actions[].name == SHELL` carrying the shell parameters.
    The `explanation` is folded into `thought:` when present; otherwise we
    use the generic shell default.
    """
    return _planner_shell_envelope(
        thought=_strip_surrogates(explanation),
        command=command,
        explanation=explanation,
        cwd=cwd,
        text="",
        providers=[],
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
        body = content[mt.end() :].strip()
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
        if isinstance(obj, dict) and (
            "commands" in obj or "analysis" in obj or "plan" in obj
        ):
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
        if isinstance(r.get("messages"), list) or isinstance(
            r.get("conversations"), list
        ):
            msgs = r.get("messages") or r.get("conversations") or []
            sys_prompt, memory, current, final = _split_history(msgs)
            if not final or not current:
                continue
            command, explanation = _terminal_assistant_extract(
                final.get("content", "") or ""
            )
            if not command:
                continue
            expected_response = encoder.encode(_shell_target(command, explanation))
            yield build(
                roomName=stable_id(slug, current["content"]),
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
        explanation = (
            r.get("explanation") or r.get("rationale") or r.get("reasoning") or ""
        )
        if not instruction or not command:
            continue
        expected_response = encoder.encode(
            _shell_target(str(command), str(explanation))
        )
        yield build(
            roomName=stable_id(slug, r.get("id") or instruction[:120]),
            agentId="agent",
            memoryEntries=[],
            currentMessage={
                "role": "user",
                "speaker": "user",
                "content": instruction,
                "channel": "dm",
            },
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
                if (
                    isinstance(obj, dict)
                    and isinstance(obj.get("commands"), list)
                    and any(
                        isinstance(c, dict) and c.get("keystrokes")
                        for c in obj.get("commands") or []
                    )
                ):
                    is_json_shell = True
            except (json.JSONDecodeError, ValueError):
                pass
        # Also handle <think>...</think>{...json envelope...}.
        if not is_json_shell:
            mt = _THINK_RE.match(body)
            if mt:
                rest = body[mt.end() :].strip()
                if rest.startswith("{") and rest.endswith("}"):
                    try:
                        obj = json.loads(rest)
                        if (
                            isinstance(obj, dict)
                            and isinstance(obj.get("commands"), list)
                            and any(
                                isinstance(c, dict) and c.get("keystrokes")
                                for c in obj.get("commands") or []
                            )
                        ):
                            is_json_shell = True
                    except (json.JSONDecodeError, ValueError):
                        pass
        m = (
            re.search(r"```(?:bash|sh)\s*\n([\s\S]*?)```", content)
            if not is_json_shell
            else None
        )

        if is_json_shell or m:
            command, explanation = _terminal_assistant_extract(content)
            if not command:
                # task_complete: true terminator with no actual shell
                # command — drop it (audit B-4 confirms these are noise).
                continue
            expected_response = encoder.encode(_shell_target(command, explanation))
            yield build(
                roomName=stable_id(slug, r.get("id") or current["content"]),
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
            slug=slug,
            license=license,
            split=split,
            sys_prompt=sys_prompt,
            memory=memory,
            current=current,
            assistant=final,
            encoder=encoder,
            tools_list=tools_list,
            default_task_type="agent_trace",
            extra_metadata={"original_id": str(r.get("id") or "")},
        )


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
            r.get("messages")
            or r.get("conversations")
            or r.get("conversation")
            or r.get("trajectory")
            or r.get("dialogue")
            or []
        )
        if not msgs:
            # Some Jackrong shards ship {"prompt", "response"} pairs.
            prompt = r.get("prompt") or r.get("instruction") or r.get("input") or ""
            response = r.get("response") or r.get("output") or r.get("completion") or ""
            if not prompt or not response:
                continue
            yield build(
                roomName=stable_id(slug, r.get("id") or prompt),
                agentId="agent",
                currentMessage={
                    "role": "user",
                    "speaker": "user",
                    "content": str(prompt),
                    "channel": "dm",
                },
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
            thought = (
                extra_thought.strip() + ("\n\n" + thought if thought else "")
            ).strip()
        if calls:
            target = encoder.encode(
                _planner_tool_envelope(
                    thought=thought,
                    tool_calls=calls,
                    text=body,
                    providers=[],
                )
            )
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
            roomName=stable_id(slug, r.get("id") or current["content"]),
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


_NUBILIO_TASK_MAP: dict[str, tuple[str, list[str]]] = {
    "action_planner_trajectories.jsonl": (
        "agent_trace",
        [ACTION_REPLY, ACTION_TASKS, ACTION_IGNORE],
    ),
    "response_trajectories.jsonl": ("reply", REPLY_ACTIONS.copy()),
    "should_respond_trajectories.jsonl": ("should_respond", ROUTING_ACTIONS.copy()),
    "context_routing_trajectories.jsonl": ("context_routing", ROUTING_ACTIONS.copy()),
    "media_description_trajectories.jsonl": ("media_description", REPLY_ACTIONS.copy()),
    "reflection_trajectories.jsonl": ("reflection", REPLY_ACTIONS.copy()),
    "reflection_evaluator_trajectories.jsonl": (
        "reflection_evaluator",
        REPLY_ACTIONS.copy(),
    ),
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
                providers.append(
                    p["name"]
                    if isinstance(p, dict) and set(p.keys()) == {"name"}
                    else p
                )
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
        if (joined.startswith('"') and joined.endswith('"')) or (
            joined.startswith("'") and joined.endswith("'")
        ):
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


def _nubilio_response_to_dict(
    text: str,
) -> tuple[dict[str, Any] | list[Any] | None, str]:
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
    """Cron-snapshot trajectories from the self-hosted nubilio eliza bot.

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
            source_file,
            ("agent_trace", [ACTION_REPLY, ACTION_TASKS, ACTION_IGNORE]),
        )

        dedup = stable_id(sys_prompt, current["content"], assistant_text)
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
