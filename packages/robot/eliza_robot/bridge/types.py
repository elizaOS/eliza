"""Shared JSON-like type aliases without using typing.Any."""

from __future__ import annotations

from typing import Dict, List, Union

JsonPrimitive = Union[str, int, float, bool, None]
JsonValue = Union[JsonPrimitive, List["JsonValue"], Dict[str, "JsonValue"]]
JsonDict = Dict[str, JsonValue]

