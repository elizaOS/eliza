"""TOON-decode + schema check for harness model outputs.

Two task types live in this harness:

  * `message_handler`   -> top-level dict with `thought`, `actions`, `text`, ...
                          For routing decisions / direct action invocations.
  * `tool_call`         -> top-level dict with `thought`, `tool_calls[]`.
                          For raw tool invocations (used when an action
                          wraps a TASK_CALL or MCP tool).

The harness mainly emits message_handler-shaped output (the runtime's actual
chat-handler template). For validation the routing assertion is:

  - On `complete_args` scenarios: the first action / tool_call must be the
    `expected_action` (or TASK_CALL with `tool == expected_action`), and
    `expected_arg_keys` must all be present in the params.
  - On `missing_required` scenarios: no expected action invocation; the
    response must contain a non-empty `thought` and a clarifying `text`,
    OR a single `REPLY` action.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


# Anti-third-person patterns. We only flag clearly-meta usage where the model
# is talking about ITSELF in third person. We allow "agent" as a domain noun
# (e.g. "spawn a testing agent", "stop the task agent") since many actions
# in the catalog are agent-orchestration tools.
_BAD_THOUGHT_PATTERNS = [
    r'\bthe\s+assistant\b',
    r'\b(an?\s+)?ai\s+(agent|assistant)\b',
    r'\bthe (response|reply|reasoning|prompt|instruction)\b',
    r'\bsilent\b',
]
_BAD_THOUGHT_RE = re.compile("|".join(_BAD_THOUGHT_PATTERNS), re.IGNORECASE)


def is_clean_thought(t: str) -> bool:
    if not t or not isinstance(t, str):
        return False
    s = t.strip()
    if len(s.split()) < 5 or len(s) > 600:
        return False
    if _BAD_THOUGHT_RE.search(s):
        return False
    return True


_FENCE_RE = re.compile(r"```(?:toon|yaml|json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def strip_wrappers(text: str) -> str:
    """Best-effort strip of markdown fences and <think> tags before decoding.

    We do NOT count this as 'graceful repair'. If a model needed wrapping,
    that's still a quality signal. The decode itself remains strict.
    """
    if not text:
        return ""
    s = _THINK_RE.sub("", text)
    m = _FENCE_RE.search(s)
    if m:
        s = m.group(1)
    return s.strip()


@dataclass
class ValidationResult:
    ok: bool
    reason: str = ""
    decoded: dict[str, Any] | None = None
    cleaned_text: str = ""


def _walk_action_names(actions: Any) -> list[str]:
    """Extract action names from a TOON-decoded actions list."""
    out: list[str] = []
    if not isinstance(actions, list):
        return out
    for a in actions:
        if isinstance(a, dict):
            n = a.get("name")
            if isinstance(n, str):
                out.append(n)
    return out


def _arg_keys_for_first_match(actions: list[Any], target: str) -> set[str]:
    """Pull the params dict for the first action matching `target`."""
    for a in actions or []:
        if not isinstance(a, dict):
            continue
        if a.get("name") == target:
            params = a.get("params") or a.get("arguments") or {}
            if isinstance(params, dict):
                return set(params.keys())
            return set()
        # nested TASK_CALL with `params.tool` matching
        params = a.get("params") or {}
        if isinstance(params, dict) and params.get("tool") == target:
            tool_args = params.get("arguments") or {}
            if isinstance(tool_args, dict):
                return set(tool_args.keys())
            return set()
    return set()


def _first_action_or_tool(decoded: dict[str, Any]) -> tuple[str, set[str]]:
    """Return (first_action_name, params_keys_set) for both task types."""
    actions = decoded.get("actions")
    if isinstance(actions, list) and actions:
        names = _walk_action_names(actions)
        if names:
            first = names[0]
            params = actions[0].get("params") or {}
            keys = set(params.keys()) if isinstance(params, dict) else set()
            return first, keys
    tool_calls = decoded.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        first = tool_calls[0]
        if isinstance(first, dict):
            name = first.get("name") or ""
            args = first.get("arguments") or {}
            keys = set(args.keys()) if isinstance(args, dict) else set()
            return str(name), keys
    return "", set()


def validate(
    *,
    raw_response: str,
    decoder,                          # ToonDecoder instance
    task_type: str,
    scenario_kind: str,
    expected_action: str,
    expected_arg_keys: list[str],
    catalog_action_names: set[str],
) -> ValidationResult:
    cleaned = strip_wrappers(raw_response)
    if not cleaned:
        return ValidationResult(False, "empty response")

    try:
        decoded = decoder.decode(cleaned)
    except (ValueError, RuntimeError) as e:
        return ValidationResult(False, f"toon decode failed: {e}", cleaned_text=cleaned)

    if not isinstance(decoded, dict):
        return ValidationResult(False, "top-level not a dict", cleaned_text=cleaned)

    thought = decoded.get("thought")
    if not is_clean_thought(thought or ""):
        return ValidationResult(False, "thought missing/dirty", decoded=decoded, cleaned_text=cleaned)

    if task_type == "tool_call":
        tool_calls = decoded.get("tool_calls")
        if scenario_kind == "missing_required":
            if not expected_arg_keys:
                # Action has no required keys: any well-formed shape is fine.
                if isinstance(tool_calls, list) and tool_calls:
                    return ValidationResult(True, "ok-no-required", decoded=decoded, cleaned_text=cleaned)
                text = decoded.get("text") or ""
                if isinstance(text, str) and text.strip():
                    return ValidationResult(True, "ok-missing", decoded=decoded, cleaned_text=cleaned)
                return ValidationResult(False, "no tool_calls and no text", decoded=decoded, cleaned_text=cleaned)
            # Must be a clarifying reply (no tool_calls), or REPLY-only message handler
            if isinstance(tool_calls, list) and tool_calls:
                return ValidationResult(False, "missing_required scenario invoked tool_call", decoded=decoded, cleaned_text=cleaned)
            text = decoded.get("text") or ""
            if not (isinstance(text, str) and text.strip()):
                return ValidationResult(False, "missing_required scenario must include clarifying text", decoded=decoded, cleaned_text=cleaned)
            return ValidationResult(True, "ok-missing", decoded=decoded, cleaned_text=cleaned)

        if not isinstance(tool_calls, list) or not tool_calls:
            return ValidationResult(False, "tool_call task missing tool_calls", decoded=decoded, cleaned_text=cleaned)

        first = tool_calls[0]
        if not isinstance(first, dict):
            return ValidationResult(False, "tool_call entry not a dict", decoded=decoded, cleaned_text=cleaned)
        name = first.get("name") or ""
        if name not in catalog_action_names:
            return ValidationResult(False, f"tool_call name '{name}' not in catalog", decoded=decoded, cleaned_text=cleaned)
        if scenario_kind in ("complete_args", "required_only"):
            if name != expected_action:
                return ValidationResult(False, f"expected {expected_action} got {name}", decoded=decoded, cleaned_text=cleaned)
            args = first.get("arguments") or {}
            if isinstance(args, dict):
                missing = [k for k in expected_arg_keys if k not in args]
                if scenario_kind == "complete_args" and missing:
                    return ValidationResult(False, f"missing required arg keys: {missing}", decoded=decoded, cleaned_text=cleaned)
        return ValidationResult(True, "ok", decoded=decoded, cleaned_text=cleaned)

    # message_handler validation
    actions = decoded.get("actions")
    if scenario_kind == "missing_required":
        names = _walk_action_names(actions or [])
        # If the catalog action has NO required keys, "missing_required"
        # is degenerate — treat any well-formed routing as acceptable.
        if not expected_arg_keys:
            if names:
                return ValidationResult(True, "ok-no-required", decoded=decoded, cleaned_text=cleaned)
            text = decoded.get("text") or ""
            if not (isinstance(text, str) and text.strip()):
                return ValidationResult(False, "no actions and no text", decoded=decoded, cleaned_text=cleaned)
            return ValidationResult(True, "ok-missing", decoded=decoded, cleaned_text=cleaned)
        # Acceptable: REPLY-only OR no actions at all but with text
        if names and any(n not in {"REPLY", "IGNORE", "STOP"} for n in names):
            return ValidationResult(False, "missing_required scenario invoked an action", decoded=decoded, cleaned_text=cleaned)
        text = decoded.get("text") or ""
        if not (isinstance(text, str) and text.strip()):
            return ValidationResult(False, "missing_required scenario must include clarifying text", decoded=decoded, cleaned_text=cleaned)
        return ValidationResult(True, "ok-missing", decoded=decoded, cleaned_text=cleaned)

    # positive scenario: must invoke an action
    if not isinstance(actions, list) or not actions:
        return ValidationResult(False, "message_handler missing actions[]", decoded=decoded, cleaned_text=cleaned)

    first_name, first_keys = _first_action_or_tool(decoded)
    if not first_name:
        return ValidationResult(False, "no first action name found", decoded=decoded, cleaned_text=cleaned)

    # Resolve TASK_CALL routing: first action might be TASK_CALL with params.tool
    routed_name = first_name
    routed_keys = first_keys
    if first_name == "TASK_CALL":
        first_action = actions[0] if isinstance(actions, list) and actions else {}
        if isinstance(first_action, dict):
            params = first_action.get("params") or {}
            if isinstance(params, dict):
                tool = params.get("tool")
                if isinstance(tool, str):
                    routed_name = tool
                    args = params.get("arguments") or {}
                    routed_keys = set(args.keys()) if isinstance(args, dict) else set()

    if routed_name in {"REPLY", "IGNORE", "STOP"}:
        return ValidationResult(False, f"positive scenario produced {routed_name}", decoded=decoded, cleaned_text=cleaned)

    if routed_name not in catalog_action_names:
        return ValidationResult(False, f"action '{routed_name}' not in catalog", decoded=decoded, cleaned_text=cleaned)

    if scenario_kind in ("complete_args", "required_only", "multilingual", "distractor"):
        if routed_name != expected_action:
            return ValidationResult(False, f"expected {expected_action} got {routed_name}", decoded=decoded, cleaned_text=cleaned)
        if scenario_kind == "complete_args" and expected_arg_keys:
            missing = [k for k in expected_arg_keys if k not in routed_keys]
            if missing:
                return ValidationResult(False, f"missing required arg keys: {missing}", decoded=decoded, cleaned_text=cleaned)

    return ValidationResult(True, "ok", decoded=decoded, cleaned_text=cleaned)
