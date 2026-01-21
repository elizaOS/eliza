"""
Task context provider for the Agent Orchestrator plugin.
"""

from __future__ import annotations

from typing import Any

from ..service import AgentOrchestratorService


def _add_header(title: str, content: str) -> str:
    """Add a markdown header to content."""
    return f"{title}\n\n{content}"


async def get_task_context(
    runtime: Any,
    message: Any,
    state: Any | None = None,
) -> dict[str, Any]:
    """Get task context for prompting."""
    svc: AgentOrchestratorService | None = runtime.get_service("CODE_TASK")

    if svc is None:
        return {
            "values": {
                "taskContext": "Task orchestrator service is not available",
                "currentTaskName": "N/A",
                "currentTaskStatus": "N/A",
            },
            "text": _add_header("# Task Context", "Task orchestrator service is not available"),
            "data": {"taskCount": 0},
        }

    context_text = await svc.get_task_context()
    current = await svc.get_current_task()

    return {
        "values": {
            "taskContext": context_text,
            "currentTaskName": current.name if current else "None",
            "currentTaskStatus": current.metadata.status.value if current else "N/A",
        },
        "text": _add_header("# Task Context", context_text),
        "data": {
            "taskCount": len(await svc.get_tasks()),
            "currentTaskId": current.id if current else None,
        },
    }


task_context_provider = {
    "name": "TASK_CONTEXT",
    "description": "Provides context about active and recent orchestrated tasks",
    "position": 90,
    "get": get_task_context,
}
