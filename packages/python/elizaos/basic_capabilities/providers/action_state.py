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
    sections: list[str] = []
    action_data: dict[str, list[str]] = {
        "pending": [],
        "completed": [],
        "available": [],
    }

    # Use the actions property instead of get_available_actions()
    available_actions = runtime.actions
    action_data["available"] = [a.name for a in available_actions]

    if action_data["available"]:
        sections.append("## Available Actions")
        sections.append(", ".join(action_data["available"]))

    if state and state.values:
        # Handle both dict-like and protobuf state.values
        values = state.values
        pending = []
        completed = []

        if hasattr(values, "get") and callable(values.get):
            # Dict-like access
            pending = values.get("pendingActions", [])
            completed = values.get("completedActions", [])
        elif hasattr(values, "extra"):
            # Protobuf - extra might be a MapField or a message
            extra = values.extra
            if hasattr(extra, "get") and callable(extra.get):
                pending_raw = extra.get("pendingActions", "")
                completed_raw = extra.get("completedActions", "")
            elif hasattr(extra, "__getitem__"):
                try:
                    pending_raw = extra.get("pendingActions", "")
                except (KeyError, TypeError):
                    pending_raw = ""
                try:
                    completed_raw = extra.get("completedActions", "")
                except (KeyError, TypeError):
                    completed_raw = ""
            else:
                pending_raw = ""
                completed_raw = ""

            # Parse if stored as string
            if isinstance(pending_raw, str) and pending_raw:
                import json

                try:
                    pending = json.loads(pending_raw)
                except json.JSONDecodeError:
                    pending = []
            elif isinstance(pending_raw, list):
                pending = pending_raw

            if isinstance(completed_raw, str) and completed_raw:
                import json

                try:
                    completed = json.loads(completed_raw)
                except json.JSONDecodeError:
                    completed = []
            elif isinstance(completed_raw, list):
                completed = completed_raw

        if isinstance(pending, list):
            action_data["pending"] = [str(a) for a in pending]

        if isinstance(completed, list):
            action_data["completed"] = [str(a) for a in completed]

    if action_data["pending"]:
        sections.append("\n## Pending Actions")
        sections.append("\n".join(f"- {a}" for a in action_data["pending"]))

    if action_data["completed"]:
        sections.append("\n## Recently Completed")
        sections.append("\n".join(f"- {a}" for a in action_data["completed"][-5:]))

    context_text = "# Action State\n" + "\n".join(sections) if sections else ""

    return ProviderResult(
        text=context_text,
        values={
            "availableActionCount": len(action_data["available"]),
            "pendingActionCount": len(action_data["pending"]),
            "completedActionCount": len(action_data["completed"]),
        },
        data=action_data,
    )


action_state_provider = Provider(
    name="ACTION_STATE",
    description="Provides information about the current action state and available actions",
    get=get_action_state_context,
    dynamic=True,
)
