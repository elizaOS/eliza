from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, TypeVar, cast

from google.protobuf.json_format import MessageToDict

from elizaos.action_docs import get_canonical_action_example_calls
from elizaos.deterministic import (
    build_conversation_seed,
    build_deterministic_seed,
    deterministic_int,
)
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


def _format_parameter_type(schema: ActionParameterSchema) -> str:
    if schema.type == "number" and (schema.minimum is not None or schema.maximum is not None):
        min_val = schema.minimum if schema.minimum is not None else "∞"
        max_val = schema.maximum if schema.maximum is not None else "∞"
        return f"number [{min_val}-{max_val}]"
    return schema.type


def _get_param_schema(param: ActionParameter) -> ActionParameterSchema | None:
    """Get schema from ActionParameter, handling both Pydantic and protobuf variants."""
    schema = getattr(param, "schema_def", None) or getattr(param, "schema", None)
    return cast("ActionParameterSchema | None", schema)


def _format_action_parameters(parameters: list[ActionParameter]) -> str:
    lines: list[str] = []
    for param in parameters:
        schema = _get_param_schema(param)
        if schema is None:
            lines.append(f"    - {param.name}: {param.description}")
            continue
        required_str = " (required)" if param.required else " (optional)"
        type_str = _format_parameter_type(schema)
        default_val = getattr(schema, "default", None) or getattr(schema, "default_value", None)
        default_str = f" [default: {default_val}]" if default_val else ""
        enum_vals = getattr(schema, "enum", None) or getattr(schema, "enum_values", None)
        enum_str = f" [values: {', '.join(enum_vals)}]" if enum_vals else ""
        examples_str = (
            f" [examples: {', '.join(repr(v) for v in param.examples)}]"
            if getattr(param, "examples", None)
            else ""
        )
        lines.append(
            f"    - {param.name}{required_str}: {param.description} ({type_str}{enum_str}{default_str}{examples_str})"
        )
    return "\n".join(lines)


T = TypeVar("T")


def _deterministic_shuffle(items: list[T], seed: str, surface: str = "shuffle") -> list[T]:
    shuffled = list(items)
    for i in range(len(shuffled) - 1, 0, -1):
        j = deterministic_int(seed, f"{surface}:{i}", i + 1)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
    return shuffled


def format_actions(actions: list[Action], seed: str | None = None) -> str:
    deterministic_seed = seed or build_deterministic_seed(
        ["actions-format", ",".join(action.name for action in actions)]
    )
    lines: list[str] = []
    for action in _deterministic_shuffle(actions, deterministic_seed, "actions"):
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


def _replace_name_placeholders_seeded(text: str, seed: str, example_index: int) -> str:
    names = ["Alex", "Jordan", "Sam", "Taylor", "Riley"]
    output = text
    for placeholder_index in range(1, 6):
        name_index = deterministic_int(
            seed,
            f"example:{example_index}:name:{placeholder_index}",
            len(names),
        )
        output = output.replace(f"{{{{name{placeholder_index}}}}}", names[name_index])
    return output


def format_action_examples(
    actions: list[Action],
    max_examples: int = 10,
    seed: str | None = None,
) -> str:
    """
    Format a deterministic subset of action examples for prompt context.

    Deterministic ordering is important to keep tests stable and avoid prompt churn.
    """
    if max_examples <= 0:
        return ""

    actions_with_examples = [
        action
        for action in actions
        if action.examples and isinstance(action.examples, list) and len(action.examples) > 0
    ]
    if not actions_with_examples:
        return ""

    examples_copy: list[list[list[ActionExample]]] = [
        [example for example in (action.examples or []) if isinstance(example, list) and example]
        for action in actions_with_examples
    ]
    available_action_indices = [
        idx for idx, action_examples in enumerate(examples_copy) if action_examples
    ]

    selection_seed = seed or build_deterministic_seed(
        [
            "action-examples",
            ",".join(action.name for action in actions_with_examples),
            max_examples,
        ]
    )

    selected_examples: list[list[ActionExample]] = []
    iteration = 0
    while len(selected_examples) < max_examples and available_action_indices:
        random_index = deterministic_int(
            selection_seed,
            f"action-index:{iteration}",
            len(available_action_indices),
        )
        action_index = available_action_indices[random_index]
        action_examples = examples_copy[action_index]

        example_index = deterministic_int(
            selection_seed,
            f"example-index:{iteration}",
            len(action_examples),
        )
        selected_examples.append(action_examples.pop(example_index))
        iteration += 1

        if not action_examples:
            available_action_indices.pop(random_index)

    blocks: list[str] = []
    for example_index, ex in enumerate(selected_examples):
        lines: list[str] = []
        for msg in ex:
            msg_text = msg.content.text if msg.content and msg.content.text else ""
            lines.append(
                f"{msg.name}: {_replace_name_placeholders_seeded(msg_text, selection_seed, example_index)}"
            )
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


def format_action_names(actions: list[Action], seed: str | None = None) -> str:
    if not actions:
        return ""

    deterministic_seed = seed or build_deterministic_seed(
        ["action-names", ",".join(action.name for action in actions)]
    )
    shuffled = _deterministic_shuffle(actions, deterministic_seed, "actions")
    return ", ".join(action.name for action in shuffled)


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
            try:
                is_valid = await validate_fn(runtime, message, state)
            except Exception:
                if hasattr(runtime, "logger"):
                    with contextlib.suppress(Exception):
                        runtime.logger.warning(
                            f"Action validation failed for {action.name}; excluding from prompt"
                        )
                is_valid = False
            if is_valid:
                validated_actions.append(action)
        else:
            # If no validation function, include the action
            validated_actions.append(action)

    action_seed = build_conversation_seed(runtime, message, state, "provider:actions")
    action_names = format_action_names(validated_actions, seed=f"{action_seed}:names")
    actions_text = format_actions(validated_actions, seed=f"{action_seed}:descriptions")
    examples_text = format_action_examples(
        validated_actions, max_examples=10, seed=f"{action_seed}:examples"
    )
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
