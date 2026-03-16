from __future__ import annotations

from typing import TypeAlias

from pydantic import BaseModel, Field

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]

JsonObject: TypeAlias = dict[str, JsonValue]


def coerce_json_value(value: object) -> JsonValue | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        out: list[JsonValue] = []
        for item in value:
            coerced = coerce_json_value(item)
            if coerced is None and item is not None:
                return None
            out.append(coerced)
        return out
    if isinstance(value, dict):
        out_obj: dict[str, JsonValue] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                return None
            coerced = coerce_json_value(v)
            if coerced is None and v is not None:
                return None
            out_obj[k] = coerced
        return out_obj
    return None


def coerce_json_object(value: object) -> JsonObject | None:
    coerced = coerce_json_value(value)
    if isinstance(coerced, dict):
        return coerced
    return None


class BridgeRequest(BaseModel):
    type: str
    request_id: str = Field(alias="requestId")
    bot_id: str | None = Field(default=None, alias="botId")
    # Use a non-recursive type for pydantic; callers can validate separately.
    data: dict[str, object] | None = None


class BridgeResponse(BaseModel):
    type: str
    request_id: str = Field(alias="requestId")
    success: bool
    # Use a non-recursive type for pydantic; callers can validate separately.
    data: dict[str, object] | None = None
    error: str | None = None
