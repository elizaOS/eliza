from __future__ import annotations

from elizaos_plugin_minecraft.protocol import coerce_json_object


def test_coerce_json_object_ok() -> None:
    obj = {"a": 1, "b": True, "c": None, "d": ["x", 2]}
    coerced = coerce_json_object(obj)
    assert coerced == obj


def test_coerce_json_object_rejects_non_string_keys() -> None:
    coerced = coerce_json_object({1: "x"})  # type: ignore[arg-type]
    assert coerced is None
