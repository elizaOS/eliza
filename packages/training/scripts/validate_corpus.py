#!/usr/bin/env python3
"""Per-task_type schema validator for eliza training corpora.

Handles two row shapes: the canonical `eliza_native_v1` boundary record
(routed to validate_native_v1) and the legacy flat ElizaRecord intermediate
(routed per metadata.task_type, below). See docs/dataset/CANONICAL_RECORD.md.

`scripts/lib/eliza_record.py:is_valid()` only enforces the FLOOR (top-level
fields present, non-empty content). This script enforces the CEILING — what
the eliza runtime actually parses for each `metadata.task_type`:

  reply                       plain-text expectedResponse, REPLY+IGNORE in
                                 availableActions, currentMessage role in
                                 {user, assistant}.

  should_respond_with_context JSON expectedResponse decoding to one of
  (alias: routing /              {RESPOND, IGNORE, STOP}, with RESPOND+
   should_respond)               IGNORE+STOP in availableActions.

  tool_call                   JSON expectedResponse with `tool_calls` field
                                 holding ≥1 `{name, arguments}` entry; the
                                 chosen action MUST be TASK_CALL or the tool
                                 name itself.

  shell_command               JSON with `command` field; SHELL_COMMAND must
                                 be in availableActions.

  agent_trace (planning)      JSON envelope: `thought` + `actions`,
                                 each action with a `name`. When
                                 `simple: true` the actions list MUST be
                                 exactly one entry (REPLY-only / single).

  mcp_tool_call / mcp_routing /
  claude_distill / reasoning_cot
                              Permissive — non-empty expectedResponse +
                                 task_type matches the record's declared
                                 token. (Distillation reasoning is shaped
                                 by upstream; we don't fight it.)

Schema-agnostic checks apply to ALL records:
  - No `"Reply to the user."` literal in `thought:` field.
  - No `"Call the tool to satisfy the request."` literal in `thought:`.
  - availableActions is non-empty (except `claude_distill`, which is
    intentionally empty per `lib/adapters.py:CLAUDE_DISTILL_SYSTEM`).
  - currentMessage.content non-empty.
  - metadata.source_dataset in the known-source allowlist (built from
    `datasets.yaml` + `lib/adapters.py:REGISTRY`).
  - Routing actions are uppercase (`RESPOND` not `respond`). DATASET_REVIEW
    flagged scambench has lowercase action bug.

Output:
  data/synthesized/review/format_validation.json with `total_records`,
  `valid_records`, per-task_type and per-source error histograms, and
  the first 50 failing records (record_id, task_type, error, fix_hint).

CLI:
  uv run python scripts/validate_corpus.py \\
    --input data/final/train.jsonl \\
    --report data/synthesized/review/format_validation.json \\
    [--strict] [--max-records N]

Exit codes:
  0 — no errors (or --strict not set and report written)
  1 — --strict and ≥1 invalid record
  2 — input file missing / unreadable
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Canonical action vocabulary (mirrors lib/eliza_record.py).
ACTION_RESPOND = "RESPOND"
ACTION_IGNORE = "IGNORE"
ACTION_STOP = "STOP"
ACTION_REPLY = "REPLY"
ACTION_TASK_CALL = "TASK_CALL"
ACTION_SHELL_COMMAND = "SHELL_COMMAND"
ROUTING_ACTIONS = {ACTION_RESPOND, ACTION_IGNORE, ACTION_STOP}

# DATASET_REVIEW.md-flagged default-thought leaks. Single source of truth
# lives in scripts/lib/eliza_record.DEFAULT_THOUGHT_LEAKS — re-import here
# so the validator and the adapters scrub the same set.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.lib.eliza_record import DEFAULT_THOUGHT_LEAKS  # noqa: E402
from scripts.lib.native_record import (  # noqa: E402
    FORMAT as ELIZA_NATIVE_FORMAT,
    validate_native_record,
)

# Stale action names that must not appear in fresh corpus rows (renamed/removed
# in the runtime — see config/eliza1_action_aliases.json and action-docs.ts).
_STALE_ACTION_NAMES = {
    "RUN_SKILL_SCRIPT": "USE_SKILL", "GET_SKILL_GUIDANCE": "USE_SKILL",
    "SPAWN_AGENT": "TASKS", "SEND_TO_AGENT": "TASKS", "STOP_AGENT": "TASKS",
    "TASK_CONTROL": "TASKS", "TASK_HISTORY": "TASKS", "TASK_SHARE": "TASKS",
    "TASK_CALL": "TASKS", "SHELL_COMMAND": "SHELL",
}


def _native_tool_name(call: dict) -> str | None:
    if not isinstance(call, dict):
        return None
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = call.get("toolName") or call.get("name") or fn.get("name")
    return name if isinstance(name, str) else None


def validate_native_v1(rec: dict) -> list[tuple[str, str]]:
    """Validator for canonical `eliza_native_v1` corpus rows (the runtime
    generateText boundary shape; see docs/dataset/CANONICAL_RECORD.md)."""
    errs: list[tuple[str, str]] = []
    ok, why = validate_native_record(rec)
    if not ok:
        errs.append(("native_v1_invalid_shape", why))
        return errs
    resp = rec.get("response") if isinstance(rec.get("response"), dict) else {}
    for call in resp.get("toolCalls") or []:
        name = _native_tool_name(call)
        if name and name in _STALE_ACTION_NAMES:
            errs.append(("native_v1_stale_action",
                         f"response tool call {name!r} is removed/renamed — "
                         f"use {_STALE_ACTION_NAMES[name]!r} "
                         "(config/eliza1_action_aliases.json)"))
    # Confirm it renders to a training example.
    try:
        from scripts.format_for_training import format_record  # noqa: PLC0415
        rendered = format_record(rec)
        if not rendered or not rendered.get("messages"):
            errs.append(("native_v1_unrenderable",
                         "format_record() produced no messages"))
    except Exception as e:  # noqa: BLE001
        errs.append(("native_v1_render_error", repr(e)))
    return errs

# task_types treated as `should_respond_with_context` for validation purposes.
ROUTING_TASK_TYPES = {"should_respond_with_context", "should_respond",
                      "context_routing", "routing"}

# task_types that are intentionally permissive (downstream-shape preserving).
PERMISSIVE_TASK_TYPES = {
    "mcp_tool_call", "mcp_routing", "claude_distill", "reasoning_cot",
    "scam_defense", "n8n_workflow_generation", "media_description",
    "reflection", "reflection_evaluator", "abliteration_harmful",
    "abliteration_harmless", "mobile_action",
}

# `claude_distill` legitimately ships with availableActions=[]; everything
# else must have at least one action.
EMPTY_ACTIONS_OK = {"claude_distill"}


def _load_source_allowlist() -> set[str]:
    """Build the allowlist of `metadata.source_dataset` values from
    `datasets.yaml` slugs + adapter REGISTRY keys."""
    sources: set[str] = set()
    yaml_path = ROOT / "datasets.yaml"
    if yaml_path.exists():
        slug_re = re.compile(r"^\s*-\s+slug:\s*([A-Za-z0-9_\-]+)\s*$")
        for line in yaml_path.read_text().splitlines():
            m = slug_re.match(line)
            if m:
                sources.add(m.group(1))
    try:
        from scripts.lib.adapters import REGISTRY  # noqa: WPS433
        sources.update(REGISTRY.keys())
    except Exception:
        pass
    # Local-only / synthesis-only sources that don't appear in REGISTRY but
    # are emitted by `scripts/synthesize_*.py`.
    sources.update({
        "scambench", "synthesized_should_respond",
        "synthesized_routing", "synthesized_action_planner",
        "synthesized_action_pairs", "synthesized_core_prompts",
        "synthesized_messaging", "synthesized_commerce",
        "synthesized_music", "synthesized_web3", "synthesized_system",
        "synthesized_agent_orch", "synthesized_reasoning",
        "synthesized_multiparty",
    })
    return sources


SOURCE_ALLOWLIST: set[str] = _load_source_allowlist()


# ──────────────────────── decode helpers ────────────────────────


def _try_decode_toon(text: str) -> tuple[bool, Any, str]:
    """Structured decode for native v5 JSON expectedResponse values.

    Returns `(ok, value, error)`.
    """
    if not isinstance(text, str) or not text.strip():
        return False, None, "empty"
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return True, json.loads(stripped), ""
        except json.JSONDecodeError as e:
            return False, None, str(e)[:200]
    return False, None, "not_json"


def _action_names(actions: list[Any]) -> list[str]:
    """availableActions can ride as bare strings OR `{name, description}`
    dicts. Adapters mostly emit strings; the schema validator accepts both."""
    out: list[str] = []
    for a in actions or []:
        if isinstance(a, str):
            out.append(a)
        elif isinstance(a, dict) and "name" in a:
            n = a.get("name")
            if isinstance(n, str):
                out.append(n)
    return out


def _planner_actions(decoded: Any) -> list[dict[str, Any]] | None:
    """Pull the `actions:` array out of a decoded planner envelope.

    Both shapes are valid:
      `{thought, actions: [{name, ...}, ...], providers, text, simple}`
      `{thought, actions: ["NAME", ...]}`  (rare but adapters allow it)
    """
    if not isinstance(decoded, dict):
        return None
    actions = decoded.get("actions")
    if not isinstance(actions, list):
        return None
    out: list[dict[str, Any]] = []
    for a in actions:
        if isinstance(a, dict):
            out.append(a)
        elif isinstance(a, str):
            out.append({"name": a})
    return out


# ──────────────────────── per-task_type validators ────────────────────────


# Each validator returns a list of `(error_code, fix_hint)` tuples. An empty
# list means the record is valid for that task_type. The errors flow back to
# the caller which adds the `record_id` + `task_type` and aggregates.

def validate_reply(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    actions = set(_action_names(rec.get("availableActions", [])))
    if ACTION_REPLY not in actions:
        errs.append(("reply_missing_REPLY_action",
                     "adapter must include REPLY in availableActions for task_type=reply"))
    if ACTION_IGNORE not in actions:
        errs.append(("reply_missing_IGNORE_action",
                     "adapter must include IGNORE in availableActions for task_type=reply"))
    role = (rec.get("currentMessage") or {}).get("role")
    if role not in ("user", "assistant"):
        errs.append(("reply_currentMessage_role_invalid",
                     f"currentMessage.role={role!r}, must be 'user' or 'assistant'"))
    return errs


def validate_routing(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    actions = set(_action_names(rec.get("availableActions", [])))
    missing = ROUTING_ACTIONS - actions
    if missing:
        errs.append((
            "routing_missing_action",
            f"task_type={rec.get('metadata', {}).get('task_type')} requires "
            f"{sorted(ROUTING_ACTIONS)} in availableActions; missing {sorted(missing)}",
        ))
    expected = (rec.get("expectedResponse") or "").strip()
    if not expected:
        errs.append(("routing_empty_expectedResponse",
                     "expectedResponse is empty"))
        return errs
    # Two acceptable shapes: a bare token "RESPOND"/"IGNORE"/"STOP", or a
    # TOON document with `action:` carrying the token (LIGHT/MultiLIGHT).
    if expected in ROUTING_ACTIONS:
        return errs
    if isinstance(decoded, dict):
        action_field = decoded.get("action")
        if isinstance(action_field, str) and action_field.upper() in ROUTING_ACTIONS:
            if action_field != action_field.upper():
                errs.append(("routing_action_lowercase",
                             f"action={action_field!r} must be uppercase"))
            return errs
        errs.append((
            "routing_decoded_no_action_field",
            "TOON document for routing must have `action: RESPOND|IGNORE|STOP`",
        ))
        return errs
    errs.append((
        "routing_expectedResponse_not_decision",
        f"expectedResponse must be one of RESPOND/IGNORE/STOP "
        f"(got {expected[:50]!r})",
    ))
    return errs


def validate_tool_call(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    if decoded is None:
        errs.append(("tool_call_invalid_toon",
                     "expectedResponse failed to TOON-decode"))
        return errs
    if not isinstance(decoded, dict):
        errs.append(("tool_call_decoded_not_object",
                     f"decoded TOON is {type(decoded).__name__}, not an object"))
        return errs
    # Two valid shapes:
    #   1. `{tool_calls: [{name, arguments}, ...]}` — the spec preference.
    #   2. Planner envelope where the actions[] entries are TASK_CALL with
    #      `params.tool` carrying the function name (the most common
    #      shape, emitted by `_planner_tool_envelope`).
    tool_calls = decoded.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        bad = [
            i for i, c in enumerate(tool_calls)
            if not (isinstance(c, dict) and isinstance(c.get("name"), str)
                    and c.get("name", "").strip())
        ]
        if bad:
            errs.append((
                "tool_call_entry_missing_name",
                f"tool_calls[{','.join(str(i) for i in bad[:3])}] missing 'name' string",
            ))
    else:
        planner_actions = _planner_actions(decoded) or []
        tool_actions = [a for a in planner_actions
                        if a.get("name") in (ACTION_TASK_CALL, "TOOL_CALL")
                        or "params" in a and isinstance(a.get("params"), dict)
                        and a["params"].get("tool")]
        if not tool_actions:
            errs.append((
                "tool_call_no_tool_calls_or_TASK_CALL",
                "tool_call task expects either `tool_calls: [{name, arguments}]` "
                "or planner `actions: [{name: TASK_CALL, params: {tool, arguments}}]`",
            ))

    actions = set(_action_names(rec.get("availableActions", [])))
    if not actions:
        errs.append(("tool_call_empty_availableActions",
                     "availableActions must be non-empty for tool_call"))
    md = rec.get("metadata", {})
    if not md.get("toolSpecs") and not md.get("tools"):
        # Soft warning surfaced under a distinct error code so the report can
        # split it out from hard failures.
        errs.append(("tool_call_no_toolSpecs_metadata_warning",
                     "metadata.toolSpecs (or .tools) absent — model has no schema "
                     "for the available tools"))
    return errs


def validate_shell_command(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    if decoded is None:
        errs.append(("shell_invalid_toon",
                     "expectedResponse failed to TOON-decode"))
        return errs
    if not isinstance(decoded, dict):
        errs.append(("shell_decoded_not_object",
                     f"decoded TOON is {type(decoded).__name__}, not an object"))
        return errs
    # Either a top-level `command: ...` or a planner envelope whose
    # SHELL_COMMAND action carries `params.command`.
    command = decoded.get("command")
    if not (isinstance(command, str) and command.strip()):
        planner_actions = _planner_actions(decoded) or []
        cmd_action = next((a for a in planner_actions
                           if a.get("name") == ACTION_SHELL_COMMAND), None)
        if cmd_action is None:
            errs.append(("shell_missing_command_field",
                         "shell_command task needs `command:` or "
                         "planner `actions: [{name: SHELL_COMMAND, params: {command}}]`"))
        else:
            params = cmd_action.get("params") or {}
            if not (isinstance(params, dict)
                    and isinstance(params.get("command"), str)
                    and params.get("command", "").strip()):
                errs.append(("shell_action_missing_params_command",
                             "SHELL_COMMAND action needs params.command non-empty"))
    actions = set(_action_names(rec.get("availableActions", [])))
    if ACTION_SHELL_COMMAND not in actions:
        errs.append(("shell_missing_SHELL_COMMAND_action",
                     "availableActions must contain SHELL_COMMAND for task_type=shell_command"))
    return errs


def validate_agent_trace(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    if decoded is None:
        errs.append(("agent_trace_invalid_toon",
                     "expectedResponse failed to TOON-decode"))
        return errs
    if not isinstance(decoded, dict):
        errs.append(("agent_trace_decoded_not_object",
                     f"decoded TOON is {type(decoded).__name__}, not an object"))
        return errs
    if not isinstance(decoded.get("thought"), str):
        errs.append(("agent_trace_missing_thought",
                     "planner envelope needs `thought:` (string)"))
    actions = decoded.get("actions")
    if not isinstance(actions, list) or not actions:
        errs.append(("agent_trace_missing_actions",
                     "planner envelope needs `actions:` array with ≥1 entry"))
    else:
        for i, a in enumerate(actions):
            name: Any = a.get("name") if isinstance(a, dict) else a
            if not (isinstance(name, str) and name.strip()):
                errs.append(("agent_trace_action_missing_name",
                             f"actions[{i}] missing or empty `name`"))
                break
        if decoded.get("simple") is True and len(actions) != 1:
            errs.append((
                "agent_trace_simple_with_multiple_actions",
                f"`simple: true` envelopes must carry exactly 1 action; got {len(actions)}",
            ))
    return errs


def validate_permissive(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    """For mcp_tool_call / mcp_routing / claude_distill / reasoning_cot etc:
    only require non-empty expectedResponse and the declared task_type."""
    errs: list[tuple[str, str]] = []
    if not (rec.get("expectedResponse") or "").strip():
        errs.append(("permissive_empty_expectedResponse",
                     "expectedResponse must be non-empty"))
    return errs


# Dispatch table — `metadata.task_type` → validator function. Aliases collapse
# (`routing` and `should_respond` both behave like
# `should_respond_with_context`).
TASK_TYPE_VALIDATORS = {
    "reply":                       validate_reply,
    "should_respond_with_context": validate_routing,
    "should_respond":              validate_routing,
    "routing":                     validate_routing,
    "context_routing":             validate_routing,
    "tool_call":                   validate_tool_call,
    "shell_command":               validate_shell_command,
    "agent_trace":                 validate_agent_trace,
    "mcp_tool_call":               validate_permissive,
    "mcp_routing":                 validate_permissive,
    "claude_distill":              validate_permissive,
    "reasoning_cot":               validate_permissive,
    "scam_defense":                validate_permissive,
    "n8n_workflow_generation":     validate_permissive,
    "media_description":           validate_permissive,
    "reflection":                  validate_permissive,
    "reflection_evaluator":        validate_permissive,
    "abliteration_harmful":        validate_permissive,
    "abliteration_harmless":       validate_permissive,
    "mobile_action":               validate_permissive,
}


# ──────────────────────── schema-agnostic checks ────────────────────────


def _extract_thought(rec: dict, decoded: Any | None) -> str | None:
    """Pull a candidate `thought:` string out of the decoded envelope or the
    raw expectedResponse."""
    if isinstance(decoded, dict):
        t = decoded.get("thought")
        if isinstance(t, str):
            return t
    raw = rec.get("expectedResponse") or ""
    if isinstance(raw, str) and "<thought>" in raw:
        m = re.search(r"<thought>(.*?)</thought>", raw, re.DOTALL)
        if m:
            return m.group(1).strip()
    return None


def schema_agnostic_checks(rec: dict, decoded: Any | None) -> list[tuple[str, str]]:
    errs: list[tuple[str, str]] = []
    md = rec.get("metadata") or {}
    task_type = md.get("task_type") or ""
    source = md.get("source_dataset") or ""

    # 1. default-thought leaks (DATASET_REVIEW.md TL;DR)
    thought = _extract_thought(rec, decoded)
    if thought:
        for leak in DEFAULT_THOUGHT_LEAKS:
            if thought.strip() == leak:
                errs.append((
                    "default_thought_leak",
                    f"thought == {leak!r} verbatim — adapter pool fix required "
                    "(see scripts/lib/adapters.py:_REPLY_THOUGHT_POOL)",
                ))
                break

    # 2. availableActions non-empty (claude_distill is intentionally empty)
    actions = rec.get("availableActions") or []
    if not actions and task_type not in EMPTY_ACTIONS_OK:
        errs.append((
            "empty_availableActions",
            f"task_type={task_type} requires non-empty availableActions",
        ))

    # 3. currentMessage.content non-empty (eliza_record.is_valid catches this
    # too, but we want a per-task_type rollup)
    cm = rec.get("currentMessage") or {}
    if not (isinstance(cm, dict) and cm.get("content")):
        errs.append(("empty_currentMessage_content",
                     "currentMessage.content must be a non-empty string"))

    # 4. source_dataset is in the known-source allowlist
    if source and source not in SOURCE_ALLOWLIST:
        errs.append((
            "unknown_source_dataset",
            f"metadata.source_dataset={source!r} not in datasets.yaml or "
            "lib/adapters.py:REGISTRY — register the source or fix the adapter",
        ))

    # 5. Routing action casing — DATASET_REVIEW.md flagged scambench has
    # lowercase actions. Apply this to every record.
    for a in _action_names(actions):
        if a in {"respond", "ignore", "stop", "reply"}:
            errs.append((
                "lowercase_routing_action",
                f"availableActions contains {a!r} — must be uppercase {a.upper()!r} "
                "(see DATASET_REVIEW.md scambench bug)",
            ))
            break

    return errs


# ──────────────────────── orchestration ────────────────────────


def validate_record(rec: dict) -> list[tuple[str, str]]:
    """Top-level dispatcher. Returns aggregated errors; empty list = valid."""
    # Canonical `eliza_native_v1` rows (the runtime generateText boundary shape)
    # have their own validator — they don't carry the flat-ElizaRecord fields
    # (roomName/currentMessage/expectedResponse/availableActions).
    if rec.get("format") == ELIZA_NATIVE_FORMAT:
        return validate_native_v1(rec)
    md = rec.get("metadata") or {}
    task_type = md.get("task_type") or ""
    expected = rec.get("expectedResponse") or ""

    # Decode the JSON expectedResponse once for task_types that need structured
    # validation — validators read from `decoded` rather than re-decoding.
    decoded: Any | None = None
    if task_type in {"tool_call", "shell_command", "agent_trace",
                     "should_respond_with_context", "should_respond",
                     "context_routing", "routing"} or task_type.startswith("mobile_"):
        ok, value, _err = _try_decode_toon(expected)
        decoded = value if ok else None

    errs = schema_agnostic_checks(rec, decoded)
    validator = TASK_TYPE_VALIDATORS.get(task_type)
    if validator is None:
        if task_type:
            errs.append((
                "unknown_task_type",
                f"metadata.task_type={task_type!r} has no validator — add to "
                "scripts/validate_corpus.py:TASK_TYPE_VALIDATORS",
            ))
        else:
            errs.append(("missing_task_type",
                         "metadata.task_type is missing or empty"))
        return errs
    errs.extend(validator(rec, decoded))
    return errs


def _record_id(rec: dict, line_no: int) -> str:
    md = rec.get("metadata") or {}
    return md.get("id") or rec.get("roomName") or f"line:{line_no}"


def iter_records(path: Path, max_records: int | None) -> Iterable[tuple[int, dict]]:
    with path.open("r", encoding="utf-8", errors="strict") as f:
        for i, line in enumerate(f, start=1):
            if max_records is not None and i > max_records:
                return
            line = line.strip()
            if not line:
                continue
            try:
                yield i, json.loads(line)
            except json.JSONDecodeError as e:
                yield i, {"_parse_error": str(e), "_raw": line[:200]}


def run(input_path: Path, report_path: Path, *, strict: bool,
        max_records: int | None) -> int:
    if not input_path.exists():
        print(f"FAIL: input not found: {input_path}", file=sys.stderr)
        return 2

    total = 0
    valid = 0
    err_by_task: dict[str, Counter] = defaultdict(Counter)
    err_by_source: dict[str, Counter] = defaultdict(Counter)
    failing: list[dict[str, Any]] = []

    for line_no, rec in iter_records(input_path, max_records):
        total += 1
        if "_parse_error" in rec:
            err_by_task["__parse__"]["json_parse_error"] += 1
            err_by_source["__parse__"]["json_parse_error"] += 1
            if len(failing) < 50:
                failing.append({
                    "record_id": f"line:{line_no}",
                    "task_type": "__parse__",
                    "error": "json_parse_error",
                    "fix_hint": rec["_parse_error"],
                })
            if strict:
                _emit(report_path, total, valid, err_by_task, err_by_source, failing)
                return 1
            continue

        errs = validate_record(rec)
        if not errs:
            valid += 1
            continue
        md = rec.get("metadata") or {}
        task_type = md.get("task_type") or "__none__"
        source = md.get("source_dataset") or "__none__"
        for code, hint in errs:
            err_by_task[task_type][code] += 1
            err_by_source[source][code] += 1
            if len(failing) < 50:
                failing.append({
                    "record_id": _record_id(rec, line_no),
                    "task_type": task_type,
                    "source_dataset": source,
                    "error": code,
                    "fix_hint": hint,
                })
        if strict:
            _emit(report_path, total, valid, err_by_task, err_by_source, failing)
            return 1

    _emit(report_path, total, valid, err_by_task, err_by_source, failing)
    return 0 if total == valid else (1 if strict else 0)


def _emit(report_path: Path, total: int, valid: int,
          err_by_task: dict[str, Counter],
          err_by_source: dict[str, Counter],
          failing: list[dict[str, Any]]) -> None:
    report = {
        "total_records": total,
        "valid_records": valid,
        "invalid_records": total - valid,
        "errors_by_task_type": {k: dict(v) for k, v in err_by_task.items()},
        "errors_by_source": {k: dict(v) for k, v in err_by_source.items()},
        "first_50_failing_records": failing[:50],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    # Also surface a one-line summary to stderr for CI greppability.
    print(
        f"[validate_corpus] total={total} valid={valid} invalid={total - valid} "
        f"report={report_path}",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, type=Path,
                   help="path to a JSONL file of eliza records")
    p.add_argument("--report", required=True, type=Path,
                   help="output path for the JSON validation report")
    p.add_argument("--strict", action="store_true",
                   help="exit 1 on the first invalid record")
    p.add_argument("--max-records", type=int, default=None,
                   help="cap number of records scanned (debugging only)")
    args = p.parse_args(argv)
    return run(args.input, args.report, strict=args.strict,
               max_records=args.max_records)


if __name__ == "__main__":
    sys.exit(main())
