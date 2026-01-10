"""
Actions Provider - Lists available actions for the agent.

This provider returns a list of all available actions that have passed
validation for the current message context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import Action, ActionParameter, ActionParameterSchema, IAgentRuntime, Memory, State


def format_action_names(actions: list[Action]) -> str:
    """Format action names as a comma-separated list."""
    return ", ".join(action.name for action in actions)


def _format_parameter_type(schema: ActionParameterSchema) -> str:
    schema_type = schema.type
    if schema_type == "number" and (schema.minimum is not None or schema.maximum is not None):
        min_val = schema.minimum if schema.minimum is not None else "∞"
        max_val = schema.maximum if schema.maximum is not None else "∞"
        return f"number [{min_val}-{max_val}]"
    return schema_type


def _format_action_parameters(parameters: list[ActionParameter]) -> str:
    lines: list[str] = []
    for param in parameters:
        required_str = " (required)" if param.required else " (optional)"
        type_str = _format_parameter_type(param.schema_def)
        default_str = (
            f" [default: {param.schema_def.default}]"
            if param.schema_def.default is not None
            else ""
        )
        enum_str = (
            f" [values: {', '.join(param.schema_def.enum)}]"
            if param.schema_def.enum
            else ""
        )
        lines.append(
            f"    - {param.name}{required_str}: {param.description} ({type_str}{enum_str}{default_str})"
        )
    return "\n".join(lines)


def format_actions(actions: list[Action]) -> str:
    """Format actions with their descriptions (including optional parameter docs)."""
    lines: list[str] = []
    for action in actions:
        line = f"- **{action.name}**: {action.description or 'No description'}"
        if action.parameters:
            params_text = _format_action_parameters(action.parameters)
            if params_text:
                line += f"\n  Parameters:\n{params_text}"
        lines.append(line)
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
    validated_actions: list[Action] = []

    # Get all registered actions from the runtime
    for action in runtime.actions:
        try:
            # Validate each action against the current message
            is_valid = await action.validate(runtime, message, state)
            if is_valid:
                validated_actions.append(action)
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
            "actions": [
                {
                    "name": a.name,
                    "description": a.description,
                    "parameters": [
                        {
                            "name": p.name,
                            "description": p.description,
                            "required": bool(p.required),
                            "schema": p.schema_def.model_dump(),
                        }
                        for p in (a.parameters or [])
                    ],
                }
                for a in validated_actions
            ],
        },
    )


# Create the provider instance
actions_provider = Provider(
    name="ACTIONS",
    description="Possible response actions",
    get=get_actions,
    position=-1,
)


