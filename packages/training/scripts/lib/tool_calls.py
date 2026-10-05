"""Normalization shared by corpus evaluation and runtime-contract checks."""

import json
from typing import Any


def call_args(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function")
    if not isinstance(function, dict):
        function = {}
    args = (
        call.get("input")
        if "input" in call
        else call.get("args")
        if "args" in call
        else call.get("arguments")
        if "arguments" in call
        else function.get("arguments")
    )
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return args if isinstance(args, dict) else {}
