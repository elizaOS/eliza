from __future__ import annotations

import json
import re
import time
from collections.abc import Mapping

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message

from elizaos.types.agent import TemplateType
from elizaos.types.state import State

_TEMPLATE_TOKEN_RE = re.compile(r"\{\{\{?\s*([A-Za-z0-9_.-]+)\s*\}\}\}?")


def get_current_time_ms() -> int:
    return int(time.time() * 1000)


def _to_dict(value: object) -> dict[str, object]:
    if isinstance(value, Message):
        return MessageToDict(value, preserving_proto_field_name=False)
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True)
    if isinstance(value, Mapping):
        return dict(value)
    raise TypeError(f"Unsupported value type: {type(value).__name__}")


def _stringify_template_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (Message, Mapping)) or hasattr(value, "model_dump"):
        return json.dumps(_to_dict(value), ensure_ascii=False)
    if isinstance(value, list):
        return "\n".join(_stringify_template_value(v) for v in value)
    return str(value)


def _render_template(template_str: str, ctx: Mapping[str, object]) -> str:
    def replacer(match: re.Match[str]) -> str:
        key = match.group(1)
        return _stringify_template_value(ctx.get(key))

    return _TEMPLATE_TOKEN_RE.sub(replacer, template_str)


def compose_prompt(*, state: Mapping[str, str], template: TemplateType) -> str:
    template_str = template({"state": state}) if callable(template) else template
    return _render_template(template_str, state)


def compose_prompt_from_state(*, state: State, template: TemplateType) -> str:
    template_str = template({"state": state}) if callable(template) else template

    dumped = _to_dict(state)
    values_raw = dumped.get("values")
    values: dict[str, object] = values_raw if isinstance(values_raw, dict) else {}

    ctx: dict[str, object] = {
        k: v for k, v in dumped.items() if k not in ("text", "values", "data")
    }
    ctx.update(values)

    return _render_template(template_str, ctx)
