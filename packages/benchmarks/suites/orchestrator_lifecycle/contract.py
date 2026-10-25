"""Defines the model-facing lifecycle contract shared by every harness.

The scored runner and no-publication canary both consume this module, so it
must remain independent of execution, scoring, reporting, and publication
code. The JSON file is the canonical TASKS schema; the Python constants only
provide one validated, consistently loaded view of it.
"""

from __future__ import annotations

import json
from pathlib import Path


# The hint establishes the orchestrator role without prescribing reply text.
# Typed planner events carry the score, leaving every harness free to reason
# and communicate through its native loop.
LIFECYCLE_SYSTEM_HINT = (
    "You are the orchestrator agent responsible for long-running tasks and "
    "subagent workers. For each user message, decide what the lifecycle "
    "situation requires — asking for missing information before starting, "
    "delegating work to a subagent, checking and reporting task status, "
    "applying a scope change to the running work, pausing, resuming, "
    "cancelling, or delivering final results. "
    "Treat references to the current workspace or codebase as the benchmark "
    "workspace already selected by the harness; do not ask for a repository "
    "path unless the user names an external repository. "
    "Perform lifecycle operations "
    "with your task-management actions rather than only describing them in "
    "prose, and reply to the user in plain language. Report lifecycle outcomes "
    "according to the returned action result; do not claim success when an "
    "action fails or is only requested. A TASKS result with captured true and "
    "effect not_executed means the requested lifecycle operation was recorded "
    "but deliberately not run. Treat that result as terminal for the current "
    "user turn: do not retry it or substitute another TASKS action solely "
    "because no side effect ran, and tell the user truthfully that execution "
    "was not performed."
)


def load_lifecycle_tasks_tool() -> dict[str, object]:
    """Load the canonical lifecycle tool contract after validating its identity."""

    path = Path(__file__).with_name("tasks-tool.json")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("type") != "function":
        raise RuntimeError(f"invalid lifecycle TASKS contract: {path}")
    function = payload.get("function")
    if not isinstance(function, dict) or function.get("name") != "TASKS":
        raise RuntimeError(f"invalid lifecycle TASKS function: {path}")
    return payload


# External runtimes receive the same parent surface as Eliza rather than
# easier event-specific leaf tools. Capture-only metadata controls execution
# and is removed by each adapter before the schema reaches the model.
LIFECYCLE_TASKS_TOOLS: tuple[dict[str, object], ...] = (load_lifecycle_tasks_tool(),)


__all__ = (
    "LIFECYCLE_SYSTEM_HINT",
    "LIFECYCLE_TASKS_TOOLS",
    "load_lifecycle_tasks_tool",
)
