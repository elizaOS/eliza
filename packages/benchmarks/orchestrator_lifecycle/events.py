"""Typed lifecycle-event extraction for the orchestrator lifecycle benchmark.

The bench server returns, per turn, the action names the agent's planner
actually selected (``MessageResponse.actions``) plus the planner-supplied
parameters (``MessageResponse.params``). This module normalizes both into a
small set of typed lifecycle events the evaluator asserts on:

    spawn         a subagent / task-agent was created
    send          input or updated instructions were forwarded to a task agent
    pause         the task was paused
    resume        the task was resumed / continued / reopened
    cancel        the task or agent was cancelled / stopped
    status_query  the live task/agent registry was consulted
    share         a task artifact / result was surfaced

The name table is derived from the runtime's real orchestrator action surface
(`plugins/plugin-agent-orchestrator/src/actions/tasks.ts` — the Pattern C
``TASKS`` parent action and its legacy leaf-action similes). The op table maps
the ``TASKS`` sub-operation values (``action`` / ``op`` / ``subaction`` /
``operation`` params) to the same events.
"""

from __future__ import annotations

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

# Action name (planner-selected, incl. legacy leaf similes) -> event.
ACTION_NAME_EVENTS: dict[str, str] = {
    # spawn
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
    # send
    "SEND_TO_AGENT": "send",
    "SEND_TO_CODING_AGENT": "send",
    "MESSAGE_CODING_AGENT": "send",
    "INPUT_TO_AGENT": "send",
    "RESPOND_TO_AGENT": "send",
    "TELL_CODING_AGENT": "send",
    "MESSAGE_AGENT": "send",
    "TELL_TASK_AGENT": "send",
    # cancel / stop
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
    # pause / resume
    "PAUSE_TASK": "pause",
    "RESUME_TASK": "resume",
    "CONTINUE_TASK": "resume",
    "REOPEN_TASK": "resume",
    "RESUME_CODING_TASK": "resume",
    "REOPEN_CODING_TASK": "resume",
    "UNARCHIVE_CODING_TASK": "resume",
    # status queries
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
    # share / surface results
    "TASK_SHARE": "share",
    "SHARE_TASK_RESULT": "share",
    "SHOW_TASK_ARTIFACT": "share",
    "VIEW_TASK_OUTPUT": "share",
}

# TASKS sub-operation value (from action/op/subaction/operation params) -> event.
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
_OPERATION_KEYS = frozenset(
    {"action", "op", "subaction", "operation", "controlaction"}
)

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
