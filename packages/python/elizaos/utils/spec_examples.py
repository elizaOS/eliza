from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from elizaos.types import ActionExample, Content

if TYPE_CHECKING:
    from elizaos.generated.action_docs import ActionDoc


def _coerce_text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _coerce_actions(value: object) -> list[str] | None:
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value)
    return None


def convert_spec_examples(spec: ActionDoc | Mapping[str, object]) -> list[list[ActionExample]]:
    examples = spec.get("examples")
    if not isinstance(examples, list):
        return []
    out: list[list[ActionExample]] = []
    for example in examples:
        if not isinstance(example, list):
            continue
        row: list[ActionExample] = []
        for msg in example:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            text = ""
            actions: list[str] | None = None
            if isinstance(content, dict):
                text = _coerce_text(content.get("text"))
                actions = _coerce_actions(content.get("actions"))
            row.append(
                ActionExample(
                    name=str(msg.get("name") or ""),
                    content=Content(text=text, actions=actions),
                )
            )
        if row:
            out.append(row)
    return out
