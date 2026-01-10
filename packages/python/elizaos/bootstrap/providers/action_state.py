"""
Action State Provider - Provides the current action state.

This provider supplies information about the current action context,
including pending actions, completed actions, and action history.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_action_state_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the current action state.

    Returns:
    - Pending actions
    - Recently completed actions
    - Action history
    """
    sections: list[str] = []
    action_data: dict[str, list[str]] = {
        "pending": [],
        "completed": [],
        "available": [],
    }

    # Get available actions from runtime
    available_actions = runtime.get_available_actions()
    action_data["available"] = [a.name for a in available_actions]

    if action_data["available"]:
        sections.append("## Available Actions")
        sections.append(", ".join(action_data["available"]))

    # Get action state from state if available
    if state and state.values:
        pending = state.values.get("pendingActions", [])
        if isinstance(pending, list):
            action_data["pending"] = [str(a) for a in pending]

        completed = state.values.get("completedActions", [])
        if isinstance(completed, list):
            action_data["completed"] = [str(a) for a in completed]

    if action_data["pending"]:
        sections.append("\n## Pending Actions")
        sections.append("\n".join(f"- {a}" for a in action_data["pending"]))

    if action_data["completed"]:
        sections.append("\n## Recently Completed")
        sections.append("\n".join(f"- {a}" for a in action_data["completed"][-5:]))

    context_text = ""
    if sections:
        context_text = "# Action State\n" + "\n".join(sections)

    return ProviderResult(
        text=context_text,
        values={
            "availableActionCount": len(action_data["available"]),
            "pendingActionCount": len(action_data["pending"]),
            "completedActionCount": len(action_data["completed"]),
        },
        data=action_data,
    )


# Create the provider instance
action_state_provider = Provider(
    name="ACTION_STATE",
    description="Provides information about the current action state and available actions",
    get=get_action_state_context,
    dynamic=True,
)
