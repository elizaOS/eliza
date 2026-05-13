"""Harness-level agent tools (todo, compact) — dispatched locally, not via sandbox."""

from __future__ import annotations

from ..models.tool import ToolSpec

# ---------------------------------------------------------------------------
# Tool specifications
# ---------------------------------------------------------------------------

TODO_TOOL = ToolSpec(
    name="todo",
    description=(
        "Create or update a task checklist to track progress on multi-step work. "
        "Pass the FULL list each time (not a diff). "
        "Only one item can be 'in_progress' at a time."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "Unique numeric ID for this item."},
                        "content": {"type": "string", "description": "Short description of the task."},
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                            "description": "Current status of this item.",
                        },
                    },
                    "required": ["id", "content", "status"],
                },
            },
        },
        "required": ["items"],
    },
)

COMPACT_TOOL = ToolSpec(
    name="compact",
    description=(
        "Compress conversation history to free up context window. "
        "Use before starting new sub-tasks or when context feels large. "
        "Preserves: task goal, file paths, todo list, key decisions."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "focus": {
                "type": "string",
                "description": "Optional: what to prioritize preserving in the summary.",
            },
        },
    },
)


def build_agent_tools(
    *,
    enable_todo: bool = True,
    enable_compact: bool = True,
) -> list[ToolSpec]:
    """Return agent-level tools based on environment config flags."""
    tools: list[ToolSpec] = []
    if enable_todo:
        tools.append(TODO_TOOL)
    if enable_compact:
        tools.append(COMPACT_TOOL)
    return tools
