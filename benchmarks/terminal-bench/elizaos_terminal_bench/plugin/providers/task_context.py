"""TASK_CONTEXT provider for injecting current benchmark task into context."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def _get_task_context(
    runtime: IAgentRuntime, _message: Memory, _state: State
) -> ProviderResult:
    """
    Get the current benchmark task context.

    This provider injects task information into the agent's context,
    including the instruction, category, difficulty, and constraints.
    """
    task = runtime.get_setting("CURRENT_TASK")

    if task is None:
        return ProviderResult(
            text="",
            values={},
            data={},
        )

    # Build task context text
    parts = []
    parts.append("## Current Terminal Benchmark Task")
    parts.append("")
    parts.append(f"**Instruction:** {task.instruction}")
    parts.append(f"**Category:** {task.category}")
    parts.append(f"**Difficulty:** {task.difficulty}")
    parts.append(f"**Timeout:** {task.timeout_seconds} seconds")

    if task.required_tools:
        parts.append(f"**Required tools:** {', '.join(task.required_tools)}")

    parts.append("")
    parts.append("**Available actions:**")
    parts.append("- EXECUTE: Run shell commands")
    parts.append("- READ_FILE: Read file contents")
    parts.append("- WRITE_FILE: Write content to a file")
    parts.append("- TOUCH: Create/truncate an empty file")
    parts.append("- LIST_DIR: List directory contents")
    parts.append("- TASK_COMPLETE: Signal task completion")
    parts.append("")
    parts.append("When you have completed the task requirements, use TASK_COMPLETE.")

    text = "\n".join(parts)

    return ProviderResult(
        text=text,
        values={
            "taskId": task.task_id,
            "taskInstruction": task.instruction,
            "taskCategory": task.category,
            "taskDifficulty": task.difficulty,
            "taskTimeout": task.timeout_seconds,
        },
        data={
            "task": {
                "id": task.task_id,
                "instruction": task.instruction,
                "category": task.category,
                "difficulty": task.difficulty,
                "timeout_seconds": task.timeout_seconds,
                "required_tools": task.required_tools or [],
            }
        },
    )


task_context_provider = Provider(
    name="TASK_CONTEXT",
    description="Provides the current terminal benchmark task information",
    position=50,  # Before RECENT_MESSAGES
    private=False,
    get=_get_task_context,
)
