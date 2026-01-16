from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("ACTION_STATE")


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
    name=_spec["name"],
    description=_spec["description"],
    get=get_action_state_context,
    position=_spec.get("position"),
    dynamic=_spec.get("dynamic", True),
)
