"""
Actions Provider - Lists available actions for the agent.

This provider returns a list of all available actions that have passed
validation for the current message context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


def format_action_names(actions: list[dict[str, str]]) -> str:
    """Format action names as a comma-separated list."""
    return ", ".join(action["name"] for action in actions)


def format_actions(actions: list[dict[str, str]]) -> str:
    """Format actions with their descriptions."""
    lines: list[str] = []
    for action in actions:
        lines.append(f"- {action['name']}: {action.get('description', 'No description')}")
    return "\n".join(lines)


async def get_actions(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get available actions for the current context.

    Returns a list of actions that have passed validation for the
    current message, along with their descriptions and examples.
    """
    validated_actions: list[dict[str, str]] = []

    # Get all registered actions from the runtime
    for action in runtime.actions:
        try:
            # Validate each action against the current message
            is_valid = await action.validate(runtime, message, state)
            if is_valid:
                validated_actions.append({
                    "name": action.name,
                    "description": action.description,
                })
        except Exception as e:
            runtime.logger.debug(
                {
                    "src": "provider:actions",
                    "agentId": runtime.agent_id,
                    "action": action.name,
                    "error": str(e),
                },
                "Action validation failed",
            )
            continue

    action_names = format_action_names(validated_actions)
    actions_text = format_actions(validated_actions)

    text_parts: list[str] = [f"Possible response actions: {action_names}"]
    if actions_text:
        text_parts.append(f"# Available Actions\n{actions_text}")

    return ProviderResult(
        text="\n\n".join(text_parts),
        values={
            "actionNames": action_names,
            "actionCount": len(validated_actions),
        },
        data={
            "actions": validated_actions,
        },
    )


# Create the provider instance
actions_provider = Provider(
    name="ACTIONS",
    description="Possible response actions",
    get=get_actions,
    position=-1,
)


