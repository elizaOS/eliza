from __future__ import annotations

from typing import TYPE_CHECKING

from google.protobuf.json_format import MessageToDict

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.prompt_compression import (
    get_prompt_action_description,
    get_prompt_parameter_description,
)
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        IAgentRuntime,
        Memory,
        State,
    )

# Get text content from centralized specs
_spec = require_provider_spec("ACTIONS")


def format_action_names(actions: list[Action]) -> str:
    return ", ".join(action.name for action in actions)


def _format_parameter_type(schema: ActionParameterSchema) -> str:
    if schema.type == "number" and (schema.minimum is not None or schema.maximum is not None):
        min_val = schema.minimum if schema.minimum is not None else "∞"
        max_val = schema.maximum if schema.maximum is not None else "∞"
        return f"number [{min_val}-{max_val}]"
    return schema.type


def _get_param_schema(param: ActionParameter) -> ActionParameterSchema | None:
    """Get schema from ActionParameter, handling both Pydantic and protobuf variants."""
    return getattr(param, "schema_def", None) or getattr(param, "schema", None)  # type: ignore[return-value]


def _format_action_parameters(
    parameters: list[ActionParameter],
    action_name: str = "",
    runtime: IAgentRuntime | None = None,
) -> str:
    lines: list[str] = []
    for param in parameters:
        schema = _get_param_schema(param)
        desc = get_prompt_parameter_description(action_name, param, runtime)
        if schema is None:
            lines.append(
                f"{param.name}{'' if param.required else '?'}:unknown - {desc}"
            )
            continue
        type_str = _format_parameter_type(schema)
        default_val = getattr(schema, "default", None) or getattr(schema, "default_value", None)
        default_str = f"default={default_val}" if default_val is not None else ""
        enum_vals = getattr(schema, "enum", None) or getattr(schema, "enum_values", None)
        enum_str = f"values={'|'.join(enum_vals)}" if enum_vals else ""
        examples_str = (
            f"examples={'|'.join(repr(v) for v in param.examples)}"
            if getattr(param, "examples", None)
            else ""
        )
        modifiers = "; ".join(part for part in [enum_str, default_str, examples_str] if part)
        suffix = f" [{modifiers}]" if modifiers else ""
        lines.append(
            f"{param.name}{'' if param.required else '?'}:{type_str}{suffix} - {desc}"
        )
    return "; ".join(lines)


def format_actions(actions: list[Action], runtime: IAgentRuntime | None = None) -> str:
    lines: list[str] = []
    for action in actions:
        desc = get_prompt_action_description(action, runtime)
        line = f"- {action.name}: {desc or 'No description'}"
        if action.parameters:
            params_text = _format_action_parameters(action.parameters, action.name, runtime)
            if params_text:
                line += f"\n  params[{len(action.parameters)}]: {params_text}"
        lines.append(line)
    return f"actions[{len(actions)}]:\n" + "\n".join(lines)


async def get_actions(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    validated_actions: list[Action] = []

    for action in runtime.actions:
        # Support both validate and validate_fn for backwards compatibility
        validate_fn = getattr(action, "validate", None) or getattr(action, "validate_fn", None)
        if validate_fn:
            is_valid = await validate_fn(runtime, message, state)
            if is_valid:
                validated_actions.append(action)
        else:
            # If no validation function, include the action
            validated_actions.append(action)

    action_names = format_action_names(validated_actions)
    actions_text = format_actions(validated_actions, runtime)

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
                            "examples": getattr(p, "examples", None) or [],
                            "schema": MessageToDict(p.schema, preserving_proto_field_name=False)
                            if hasattr(p, "schema") and p.schema.ByteSize() > 0
                            else (getattr(p, "schema_def", None) or None),
                        }
                        for p in (a.parameters or [])
                    ],
                }
                for a in validated_actions
            ],
        },
    )


actions_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_actions,
    position=_spec.get("position", -1),
)
