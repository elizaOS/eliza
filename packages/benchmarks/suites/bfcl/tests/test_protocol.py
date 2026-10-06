"""One contract for BFCL schema adaptation shared by the native harnesses."""

from benchmarks.suites.bfcl import provider_safe_tools as _provider_safe_tools


def test_provider_safe_tools_uniquifies_collisions() -> None:
    tools = [
        {
            "type": "function",
            "function": {"name": "foo.bar", "description": "", "parameters": {}},
        },
        {
            "type": "function",
            "function": {"name": "foo_bar", "description": "", "parameters": {}},
        },
    ]

    patched, name_map = _provider_safe_tools(tools)

    names = [tool["function"]["name"] for tool in patched]
    assert names == ["foo_bar", "foo_bar_2"]
    assert name_map == {"foo_bar": "foo.bar", "foo_bar_2": "foo_bar"}


def test_provider_safe_tools_preserves_schema_field_names_and_defaults() -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "customer.lookup",
                "description": "Lookup a customer",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "customerId": {
                            "type": "string",
                            "description": "Stable customer id",
                        },
                        "includeInactive": {
                            "type": "boolean",
                            "description": "Include inactive customers",
                            "default": False,
                        },
                    },
                    "required": ["customerId"],
                },
            },
        }
    ]

    patched, name_map = _provider_safe_tools(tools)

    function = patched[0]["function"]
    properties = function["parameters"]["properties"]
    assert function["name"] == "customer_lookup"
    assert name_map == {"customer_lookup": "customer.lookup"}
    assert list(properties) == ["customerId", "includeInactive"]
    assert properties["includeInactive"]["default"] is False
    assert tools[0]["function"]["name"] == "customer.lookup"


def test_malformed_arguments_cannot_become_a_valid_empty_call():
    import pytest
    from benchmarks.suites.bfcl import coerce_arguments

    for invalid in ("not-json", "[]", [], None):
        with pytest.raises(ValueError):
            coerce_arguments(invalid)
    assert coerce_arguments("{}") == {}
