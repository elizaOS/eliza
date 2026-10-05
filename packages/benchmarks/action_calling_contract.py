"""Defines the shared, type-safe scoring contract for action-calling cases.

The runner and publication registry both call this module so recorded case
booleans cannot diverge from the scorer that independently verifies them.
JSON objects and arrays must match exactly; the only representation tolerance
is equivalent ISO datetimes and equal non-boolean JSON numbers such as 1/1.0.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any


ACTION_CALLING_METRIC_NAMES = (
    "native_tool_calls_ok",
    "tool_name_match",
    "args_parse_ok",
    "required_keys_ok",
    "arguments_match",
)


def _object(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _parse_iso_datetime(value: str) -> datetime | None:
    raw = value.strip()
    if "T" not in raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def action_calling_values_match(expected: object, actual: object) -> bool:
    """Compare JSON values recursively without string or boolean coercion."""

    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping) or set(expected) != set(actual):
            return False
        return all(
            action_calling_values_match(value, actual[key])
            for key, value in expected.items()
        )
    if isinstance(expected, Sequence) and not isinstance(
        expected, (str, bytes, bytearray)
    ):
        if not isinstance(actual, Sequence) or isinstance(
            actual, (str, bytes, bytearray)
        ):
            return False
        return len(expected) == len(actual) and all(
            action_calling_values_match(expected_item, actual_item)
            for expected_item, actual_item in zip(expected, actual, strict=True)
        )
    if isinstance(expected, str):
        if not isinstance(actual, str):
            return False
        expected_datetime = _parse_iso_datetime(expected)
        actual_datetime = _parse_iso_datetime(actual)
        if expected_datetime is not None and actual_datetime is not None:
            return expected_datetime == actual_datetime
        return expected == actual
    if isinstance(expected, bool) or isinstance(actual, bool):
        return (
            isinstance(expected, bool)
            and isinstance(actual, bool)
            and expected == actual
        )
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and expected == actual
    if expected is None:
        return actual is None
    return type(expected) is type(actual) and expected == actual


def _required_keys(
    expected: Mapping[str, Any], tools: Sequence[Mapping[str, Any]]
) -> set[str]:
    arguments = _object(expected.get("arguments"))
    required = set(arguments)
    expected_name = expected.get("name")
    for tool in tools:
        function = _object(tool.get("function"))
        if function.get("name") != expected_name:
            continue
        schema = _object(function.get("parameters"))
        schema_required = schema.get("required")
        if isinstance(schema_required, Sequence) and not isinstance(
            schema_required, (str, bytes, bytearray)
        ):
            required.update(item for item in schema_required if isinstance(item, str))
        break
    return required


def score_action_calling_case(
    expected_calls: Sequence[Mapping[str, Any]],
    predicted_calls: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]],
) -> dict[str, bool]:
    """Recompute the five public case outcomes from calls and tool schemas."""

    exact_count = len(predicted_calls) == len(expected_calls)
    scores = {
        "native_tool_calls_ok": bool(predicted_calls),
        "tool_name_match": exact_count
        and all(
            predicted_calls[index].get("name") == expected.get("name")
            for index, expected in enumerate(expected_calls)
        ),
        "args_parse_ok": exact_count
        and all(
            isinstance(predicted_calls[index].get("arguments"), Mapping)
            for index in range(len(expected_calls))
        ),
        "required_keys_ok": exact_count,
        "arguments_match": exact_count,
    }
    for index, expected in enumerate(expected_calls):
        if index >= len(predicted_calls):
            scores["required_keys_ok"] = False
            scores["arguments_match"] = False
            break
        predicted_arguments = _object(predicted_calls[index].get("arguments"))
        if not _required_keys(expected, tools).issubset(predicted_arguments):
            scores["required_keys_ok"] = False
        expected_arguments = expected.get("arguments")
        if not isinstance(
            expected_arguments, Mapping
        ) or not action_calling_values_match(expected_arguments, predicted_arguments):
            scores["arguments_match"] = False
    return scores


__all__ = [
    "ACTION_CALLING_METRIC_NAMES",
    "action_calling_values_match",
    "score_action_calling_case",
]
