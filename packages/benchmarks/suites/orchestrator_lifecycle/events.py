"""Normalizes planner action evidence into lifecycle events for structural scoring.

The evaluator consumes both the runtime's ``TASKS`` parent operation and its
compatible leaf-action aliases. Response-plumbing fields are excluded because
they can contain actions captured on prior turns.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence

LIFECYCLE_EVENTS: tuple[str, ...] = (
    "spawn",
    "send",
    "pause",
    "resume",
    "cancel",
    "status_query",
    "share",
)

ACTION_NAME_EVENTS: dict[str, str] = {
    "CREATE_AGENT_TASK": "spawn",
    "CREATE_TASK": "spawn",
    "START_CODING_TASK": "spawn",
    "LAUNCH_CODING_TASK": "spawn",
    "RUN_CODING_TASK": "spawn",
    "START_AGENT_TASK": "spawn",
    "SPAWN_AND_PROVISION": "spawn",
    "LAUNCH_TASK": "spawn",
    "CREATE_SUBTASK": "spawn",
    "SPAWN_AGENT": "spawn",
    "SPAWN_CODING_AGENT": "spawn",
    "START_CODING_AGENT": "spawn",
    "LAUNCH_CODING_AGENT": "spawn",
    "CREATE_CODING_AGENT": "spawn",
    "SPAWN_CODER": "spawn",
    "RUN_CODING_AGENT": "spawn",
    "SPAWN_SUB_AGENT": "spawn",
    "START_TASK_AGENT": "spawn",
    "CREATE_AGENT": "spawn",
    "SEND_TO_AGENT": "send",
    "SEND_TO_CODING_AGENT": "send",
    "MESSAGE_CODING_AGENT": "send",
    "INPUT_TO_AGENT": "send",
    "RESPOND_TO_AGENT": "send",
    "TELL_CODING_AGENT": "send",
    "MESSAGE_AGENT": "send",
    "TELL_TASK_AGENT": "send",
    "CANCEL_TASK": "cancel",
    "STOP_TASK": "cancel",
    "ABORT_TASK": "cancel",
    "KILL_TASK": "cancel",
    "STOP_SUBTASK": "cancel",
    "STOP_AGENT": "cancel",
    "STOP_CODING_AGENT": "cancel",
    "KILL_CODING_AGENT": "cancel",
    "TERMINATE_AGENT": "cancel",
    "END_CODING_SESSION": "cancel",
    "CANCEL_AGENT": "cancel",
    "CANCEL_TASK_AGENT": "cancel",
    "STOP_SUB_AGENT": "cancel",
    "PAUSE_TASK": "pause",
    "RESUME_TASK": "resume",
    "CONTINUE_TASK": "resume",
    "REOPEN_TASK": "resume",
    "RESUME_CODING_TASK": "resume",
    "REOPEN_CODING_TASK": "resume",
    "UNARCHIVE_CODING_TASK": "resume",
    "LIST_AGENTS": "status_query",
    "LIST_CODING_AGENTS": "status_query",
    "SHOW_CODING_AGENTS": "status_query",
    "GET_ACTIVE_AGENTS": "status_query",
    "LIST_SESSIONS": "status_query",
    "SHOW_CODING_SESSIONS": "status_query",
    "SHOW_TASK_AGENTS": "status_query",
    "LIST_SUB_AGENTS": "status_query",
    "SHOW_TASK_STATUS": "status_query",
    "TASK_HISTORY": "status_query",
    "LIST_TASK_HISTORY": "status_query",
    "GET_TASK_HISTORY": "status_query",
    "SHOW_TASKS": "status_query",
    "COUNT_TASKS": "status_query",
    "TASK_STATUS_HISTORY": "status_query",
    "TASK_SHARE": "share",
    "SHARE_TASK_RESULT": "share",
    "SHOW_TASK_ARTIFACT": "share",
    "VIEW_TASK_OUTPUT": "share",
}

OPERATION_EVENTS: dict[str, str] = {
    "create": "spawn",
    "spawn_agent": "spawn",
    "send": "send",
    "cancel": "cancel",
    "stop": "cancel",
    "stop_agent": "cancel",
    "pause": "pause",
    "resume": "resume",
    "continue": "resume",
    "reopen": "resume",
    "list_agents": "status_query",
    "list": "status_query",
    "history": "status_query",
    "status": "status_query",
    "share": "share",
}

# Param keys whose values identify a TASKS sub-operation. `controlAction`
# is the real runtime param for TASKS control ops (action=control,
# controlAction=pause|resume|stop|continue|reopen — see core action docs).
_OPERATION_KEYS = frozenset({"action", "op", "subaction", "operation", "controlaction"})

# Bridge params that carry response plumbing, not planner-selected operations.
# The trajectory snapshot in particular contains full prior steps and would
# leak events from earlier turns into the current one.
_IGNORED_PARAM_KEYS = frozenset(
    {
        "_eliza_trajectory_snapshot",
        "_eliza_trajectory_snapshot_error",
        "eliza_metadata",
        "usage",
    }
)


def _collect_operation_values(value: object, found: list[str]) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_str = str(key)
            if key_str in _IGNORED_PARAM_KEYS:
                continue
            if key_str.lower() in _OPERATION_KEYS and isinstance(child, str):
                found.append(child.strip().lower())
            if key_str.lower() == "arguments" and isinstance(child, str):
                decoded = json.loads(child)
                if isinstance(decoded, (Mapping, Sequence)) and not isinstance(
                    decoded, (str, bytes, bytearray)
                ):
                    _collect_operation_values(decoded, found)
            _collect_operation_values(child, found)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            _collect_operation_values(child, found)


def extract_lifecycle_events(
    actions: Sequence[str],
    params: Mapping[str, object] | None = None,
) -> list[str]:
    """Normalize a turn's planner actions + params into typed lifecycle events.

    Unmapped action names (REPLY, IGNORE, providers, …) and unmapped operation
    values contribute nothing — there is no fallback that turns prose or
    unknown data into an event.
    """
    events: list[str] = []

    def add(event: str) -> None:
        if event not in events:
            events.append(event)

    for name in actions:
        mapped = ACTION_NAME_EVENTS.get(str(name).strip().upper())
        if mapped:
            add(mapped)

    if params:
        operations: list[str] = []
        _collect_operation_values(params, operations)
        for op in operations:
            mapped = OPERATION_EVENTS.get(op)
            if mapped:
                add(mapped)

    return events
