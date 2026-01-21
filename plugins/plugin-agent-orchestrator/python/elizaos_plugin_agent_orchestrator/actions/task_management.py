"""
Task management actions for the Agent Orchestrator plugin.
"""

from __future__ import annotations

import re
from typing import Any

from ..service import AgentOrchestratorService


def _get_service(runtime: Any) -> AgentOrchestratorService:
    """Get the orchestrator service from runtime."""
    svc = runtime.get_service("CODE_TASK")
    if svc is None:
        raise RuntimeError("AgentOrchestratorService not available (CODE_TASK)")
    return svc


def _extract_query(text: str) -> str:
    """Extract search query from text."""
    result = text.lower()
    result = re.sub(
        r"\b(switch|select|go|change|search|find|pause|stop|halt|resume|restart|continue|start|run|begin|cancel|delete|remove|list|show|view)\b",
        "",
        result,
    )
    result = re.sub(r"\b(about|for|named|called|with|to|my|your|our|this|current)\b", "", result)
    result = re.sub(r"\b(task|tasks|the|a|an)\b", "", result)
    result = re.sub(r"\s+", " ", result)
    return result.strip()


# ============================================================================
# CREATE_TASK
# ============================================================================

create_task_action = {
    "name": "CREATE_TASK",
    "similes": ["START_TASK", "SPAWN_TASK", "NEW_TASK", "BEGIN_TASK"],
    "description": "Create an orchestrated background task to be executed by a selected agent provider.",
}


async def validate_create_task(runtime: Any, message: Any) -> bool:
    """Validate CREATE_TASK action."""
    text = (getattr(message.content, "text", "") or "").lower()
    has_explicit = "create task" in text or "new task" in text or "start a task" in text
    has_intent = any(
        word in text
        for word in ["implement", "build", "create", "develop", "refactor", "fix", "add"]
    )
    return has_explicit or has_intent


async def handle_create_task(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle CREATE_TASK action."""
    svc = _get_service(runtime)
    raw = getattr(message.content, "text", "") or ""

    opts = options or {}
    name = (opts.get("title") or raw.split("\n")[0] or "New Task").strip()[:100] or "New Task"
    description = (opts.get("description") or raw).strip()[:4000] or name

    room_id = getattr(message, "room_id", None) or getattr(message, "roomId", None)
    task = await svc.create_task(name, description, room_id)

    step_lines = opts.get("steps")
    if isinstance(step_lines, list) and step_lines:
        for s in step_lines:
            step = str(s).strip()
            if step:
                await svc.add_step(task.id, step)
        await svc.append_output(
            task.id, "Plan:\n" + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(step_lines))
        )

    msg = (
        f"Created task: {task.name}\n"
        f"Provider: {task.metadata.provider_label or task.metadata.provider_id}\n"
        f"Starting execution…"
    )

    if callback:
        await callback({"content": {"text": msg}})

    svc.start_task_execution(task.id)

    return {"success": True, "text": msg, "data": {"taskId": task.id}}


create_task_action["validate"] = validate_create_task
create_task_action["handler"] = handle_create_task


# ============================================================================
# LIST_TASKS
# ============================================================================

list_tasks_action = {
    "name": "LIST_TASKS",
    "similes": ["SHOW_TASKS", "GET_TASKS", "TASKS", "VIEW_TASKS"],
    "description": "List tasks managed by the orchestrator.",
}


async def validate_list_tasks(runtime: Any, message: Any) -> bool:
    """Validate LIST_TASKS action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return "list task" in text or "show task" in text or text == "tasks" or "my task" in text


async def handle_list_tasks(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle LIST_TASKS action."""
    svc = _get_service(runtime)
    tasks = await svc.get_recent_tasks(20)

    if not tasks:
        msg = "No tasks."
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": True, "text": msg}

    lines = ["Tasks:"]
    current = svc.get_current_task_id()
    for t in tasks:
        marker = " (current)" if t.id == current else ""
        lines.append(f"- {t.name} — {t.metadata.status.value} {t.metadata.progress}%{marker}")

    msg = "\n".join(lines)
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg}


list_tasks_action["validate"] = validate_list_tasks
list_tasks_action["handler"] = handle_list_tasks


# ============================================================================
# SWITCH_TASK
# ============================================================================

switch_task_action = {
    "name": "SWITCH_TASK",
    "similes": ["SELECT_TASK", "SET_TASK", "CHANGE_TASK", "GO_TO_TASK"],
    "description": "Switch the current task context to a different task.",
}


async def validate_switch_task(runtime: Any, message: Any) -> bool:
    """Validate SWITCH_TASK action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return (
        "switch to task" in text or "select task" in text or ("task" in text and "switch" in text)
    )


async def handle_switch_task(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle SWITCH_TASK action."""
    svc = _get_service(runtime)
    query = _extract_query(getattr(message.content, "text", "") or "")

    if not query:
        msg = "Please specify which task to switch to (by name or id)."
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    matches = await svc.search_tasks(query)
    chosen = matches[0] if matches else None

    if not chosen or not chosen.id:
        msg = f'No task found matching: "{query}"'
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    svc.set_current_task(chosen.id)
    msg = f"Switched to task: {chosen.name}"
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg, "data": {"taskId": chosen.id}}


switch_task_action["validate"] = validate_switch_task
switch_task_action["handler"] = handle_switch_task


# ============================================================================
# SEARCH_TASKS
# ============================================================================

search_tasks_action = {
    "name": "SEARCH_TASKS",
    "similes": ["FIND_TASK", "LOOKUP_TASK"],
    "description": "Search tasks by query.",
}


async def validate_search_tasks(runtime: Any, message: Any) -> bool:
    """Validate SEARCH_TASKS action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return "search task" in text or "find task" in text or "look for task" in text


async def handle_search_tasks(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle SEARCH_TASKS action."""
    svc = _get_service(runtime)
    opts = options or {}
    query = (
        opts.get("query") or _extract_query(getattr(message.content, "text", "") or "")
    ).strip()

    if not query:
        msg = "What would you like to search for?"
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    matches = await svc.search_tasks(query)

    if not matches:
        msg = f'No tasks found matching: "{query}"'
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": True, "text": msg}

    lines = [f'Found {len(matches)} task(s) matching "{query}":']
    for t in matches[:10]:
        lines.append(f"- {t.name} — {t.metadata.status.value} {t.metadata.progress}%")

    msg = "\n".join(lines)
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg}


search_tasks_action["validate"] = validate_search_tasks
search_tasks_action["handler"] = handle_search_tasks


# ============================================================================
# PAUSE_TASK
# ============================================================================

pause_task_action = {
    "name": "PAUSE_TASK",
    "similes": ["STOP_TASK", "HALT_TASK"],
    "description": "Pause a running task.",
}


async def validate_pause_task(runtime: Any, message: Any) -> bool:
    """Validate PAUSE_TASK action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return any(word in text for word in ["pause", "stop", "halt"]) and "task" in text


async def handle_pause_task(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle PAUSE_TASK action."""
    svc = _get_service(runtime)
    query = _extract_query(getattr(message.content, "text", "") or "")
    task = (await svc.search_tasks(query))[0] if query else await svc.get_current_task()

    if not task or not task.id:
        msg = "No task to pause."
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    await svc.pause_task(task.id)
    msg = f"Paused task: {task.name}"
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg}


pause_task_action["validate"] = validate_pause_task
pause_task_action["handler"] = handle_pause_task


# ============================================================================
# RESUME_TASK
# ============================================================================

resume_task_action = {
    "name": "RESUME_TASK",
    "similes": ["CONTINUE_TASK", "RESTART_TASK", "RUN_TASK"],
    "description": "Resume a paused task.",
}


async def validate_resume_task(runtime: Any, message: Any) -> bool:
    """Validate RESUME_TASK action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return "task" in text and any(word in text for word in ["resume", "restart", "continue"])


async def handle_resume_task(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle RESUME_TASK action."""
    svc = _get_service(runtime)
    query = _extract_query(getattr(message.content, "text", "") or "")
    task = (await svc.search_tasks(query))[0] if query else await svc.get_current_task()

    if not task or not task.id:
        msg = "No task to resume."
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    await svc.resume_task(task.id)
    svc.start_task_execution(task.id)
    msg = f"Resumed task: {task.name}"
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg}


resume_task_action["validate"] = validate_resume_task
resume_task_action["handler"] = handle_resume_task


# ============================================================================
# CANCEL_TASK
# ============================================================================

cancel_task_action = {
    "name": "CANCEL_TASK",
    "similes": ["DELETE_TASK", "REMOVE_TASK", "ABORT_TASK"],
    "description": "Cancel a task.",
}


async def validate_cancel_task(runtime: Any, message: Any) -> bool:
    """Validate CANCEL_TASK action."""
    text = (getattr(message.content, "text", "") or "").lower()
    return any(word in text for word in ["cancel", "delete", "remove"]) and "task" in text


async def handle_cancel_task(
    runtime: Any,
    message: Any,
    state: Any | None = None,
    options: dict[str, Any] | None = None,
    callback: Any | None = None,
) -> dict[str, Any]:
    """Handle CANCEL_TASK action."""
    svc = _get_service(runtime)
    query = _extract_query(getattr(message.content, "text", "") or "")
    task = (await svc.search_tasks(query))[0] if query else await svc.get_current_task()

    if not task or not task.id:
        msg = "No task to cancel."
        if callback:
            await callback({"content": {"text": msg}})
        return {"success": False, "text": msg}

    await svc.cancel_task(task.id)
    msg = f"Cancelled task: {task.name}"
    if callback:
        await callback({"content": {"text": msg}})
    return {"success": True, "text": msg}


cancel_task_action["validate"] = validate_cancel_task
cancel_task_action["handler"] = handle_cancel_task
