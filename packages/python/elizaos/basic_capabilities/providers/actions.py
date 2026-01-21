from __future__ import annotations

from typing import TYPE_CHECKING

from google.protobuf.json_format import MessageToDict

from elizaos.action_docs import get_canonical_action_example_calls
from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult
from elizaos.types.components import ActionExample

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
        enum_str = f" [values: {', '.join(param.schema_def.enum)}]" if param.schema_def.enum else ""
        examples_str = (
            f" [examples: {', '.join(repr(v) for v in param.examples)}]" if param.examples else ""
        )
        lines.append(
            f"    - {param.name}{required_str}: {param.description} ({type_str}{enum_str}{default_str}{examples_str})"
        )
    return "\n".join(lines)


def format_actions(actions: list[Action]) -> str:
    lines: list[str] = []
    for action in actions:
        line = f"- **{action.name}**: {action.description or 'No description'}"
        if action.parameters:
            params_text = _format_action_parameters(action.parameters)
            if params_text:
                line += f"\n  Parameters:\n{params_text}"
        lines.append(line)
    return "\n".join(lines)


def _replace_name_placeholders(text: str) -> str:
    names = ["Alex", "Jordan", "Sam", "Taylor", "Riley"]
    for i, name in enumerate(names, start=1):
        text = text.replace(f"{{{{name{i}}}}}", name)
    return text


def format_action_examples(actions: list[Action], max_examples: int = 10) -> str:
    """
    Format a deterministic subset of action examples for prompt context.

    Deterministic ordering is important to keep tests stable and avoid prompt churn.
    """
    if max_examples <= 0:
        return ""

    examples: list[list[ActionExample]] = []
    for action in sorted(actions, key=lambda a: a.name):
        if not action.examples:
            continue
        for ex in action.examples:
            if isinstance(ex, list) and ex:
                examples.append(ex)
            if len(examples) >= max_examples:
                break
        if len(examples) >= max_examples:
            break

    if not examples:
        return ""

    blocks: list[str] = []
    for ex in examples:
        lines: list[str] = []
        for msg in ex:
            msg_text = msg.content.text if msg.content and msg.content.text else ""
            lines.append(f"{msg.name}: {_replace_name_placeholders(msg_text)}")
        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


def _escape_xml_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def format_action_call_examples(actions: list[Action], max_examples: int = 5) -> str:
    """
    Format canonical action-call examples (including optional <params> blocks).

    Deterministic ordering is important to keep tests stable and avoid prompt churn.
    """
    if max_examples <= 0:
        return ""

    blocks: list[str] = []
    for action in sorted(actions, key=lambda a: a.name):
        calls = get_canonical_action_example_calls(action.name)
        for call in calls:
            user = call.get("user")
            action_names = call.get("actions")
            params = call.get("params")

            if not isinstance(user, str) or not isinstance(action_names, list):
                continue
            if not all(isinstance(a, str) for a in action_names):
                continue

            actions_xml = "\n".join(
                f"  <action>{_escape_xml_text(a)}</action>" for a in action_names
            )

            params_xml = ""
            if isinstance(params, dict):
                blocks_xml: list[str] = []
                for act_name, act_params in params.items():
                    if not isinstance(act_name, str) or not isinstance(act_params, dict):
                        continue
                    inner: list[str] = []
                    for k, v in act_params.items():
                        if not isinstance(k, str):
                            continue
                        if isinstance(v, str):
                            raw = v
                        elif v is None:
                            raw = "null"
                        elif isinstance(v, bool):
                            raw = "true" if v else "false"
                        elif isinstance(v, (int, float)):
                            raw = str(v)
                        else:
                            raw = repr(v)
                        inner.append(f"    <{k}>{_escape_xml_text(raw)}</{k}>")
                    blocks_xml.append(f"  <{act_name}>\n" + "\n".join(inner) + f"\n  </{act_name}>")
                if blocks_xml:
                    params_xml = "\n<params>\n" + "\n".join(blocks_xml) + "\n</params>"

            blocks.append(
                f"User: {user}\nAssistant:\n<actions>\n{actions_xml}\n</actions>{params_xml}"
            )
            if len(blocks) >= max_examples:
                return "\n\n".join(blocks)

    return "\n\n".join(blocks)


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
    actions_text = format_actions(validated_actions)
    examples_text = format_action_examples(validated_actions, max_examples=10)
    call_examples_text = format_action_call_examples(validated_actions, max_examples=5)

    text_parts: list[str] = [f"Possible response actions: {action_names}"]
    if actions_text:
        text_parts.append(f"# Available Actions\n{actions_text}")
    if examples_text:
        text_parts.append(f"# Action Examples\n{examples_text}")
    if call_examples_text:
        text_parts.append(f"# Action Call Examples (with <params>)\n{call_examples_text}")

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
                    "examples": [
                        [
                            {
                                "name": ex.name,
                                "content": MessageToDict(
                                    ex.content, preserving_proto_field_name=False
                                ),
                            }
                            for ex in example
                        ]
                        for example in (a.examples or [])
                    ],
                    "parameters": [
                        {
                            "name": p.name,
                            "description": p.description,
                            "required": bool(p.required),
                            "examples": p.examples,
                            "schema": MessageToDict(p.schema, preserving_proto_field_name=False)
                            if hasattr(p, "schema")
                            else None,
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
