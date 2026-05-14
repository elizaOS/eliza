"""Tests for BFCL plugin schema helpers."""

from benchmarks.bfcl.plugin import generate_function_schema
from benchmarks.bfcl.types import FunctionDefinition, FunctionParameter


def test_any_parameter_type_is_unconstrained() -> None:
    function = FunctionDefinition(
        name="inspect_payload",
        description="Inspect an arbitrary payload.",
        parameters={
            "payload": FunctionParameter(
                name="payload",
                param_type="any",
                description="Arbitrary JSON payload.",
            ),
        },
        required_params=["payload"],
    )

    schema = generate_function_schema(function)

    payload_schema = schema["parameters"]["properties"]["payload"]
    assert payload_schema["description"] == "Arbitrary JSON payload."
    assert "type" not in payload_schema


def test_pythonish_parameter_types_are_normalized() -> None:
    function = FunctionDefinition(
        name="score_payload",
        description="Score nested payload data.",
        parameters={
            "score": FunctionParameter(
                name="score",
                param_type="float",
                description="Numeric score.",
            ),
            "payload": FunctionParameter(
                name="payload",
                param_type="dict",
                description="Nested payload.",
                properties={
                    "items": {"type": "list", "items": {"type": "str"}},
                },
            ),
        },
        required_params=["score", "payload"],
    )

    schema = generate_function_schema(function)

    properties = schema["parameters"]["properties"]
    assert properties["score"]["type"] == "number"
    assert properties["payload"]["type"] == "object"
    assert properties["payload"]["properties"]["items"]["type"] == "array"
    assert properties["payload"]["properties"]["items"]["items"]["type"] == "string"


def test_array_shape_wins_over_stale_scalar_type() -> None:
    function = FunctionDefinition(
        name="sql.execute",
        description="Execute SQL.",
        parameters={
            "columns": FunctionParameter(
                name="columns",
                param_type="string",
                description="Columns to use.",
                items={"type": "string"},
            ),
            "timestamp": FunctionParameter(
                name="timestamp",
                param_type="boolean",
                description="Append timestamp.",
                default="False",
            ),
        },
        required_params=["columns"],
    )

    schema = generate_function_schema(function)

    properties = schema["parameters"]["properties"]
    assert properties["columns"]["type"] == "array"
    assert properties["columns"]["items"]["type"] == "string"
    assert properties["timestamp"]["type"] == "boolean"
    assert properties["timestamp"]["default"] is False
