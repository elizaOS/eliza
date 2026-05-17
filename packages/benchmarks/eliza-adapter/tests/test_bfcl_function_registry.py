"""Tests for ``ElizaBFCLFunctionRegistry`` and adapter integration."""
from __future__ import annotations

import json
from pathlib import Path

import eliza_adapter.bfcl as bfcl
from eliza_adapter.bfcl import (
    DEFAULT_ELIZA_ACTION_CATALOG_PATH,
    ElizaBFCLFunctionRegistry,
    _extract_calls_from_response,
    get_default_registry,
)


# --------------------------------------------------------------------------- #
# Catalog file & registry construction                                         #
# --------------------------------------------------------------------------- #

EXPECTED_ACTION_NAMES = {
    "PAYMENT",
    "SHELL",
    "FILE",
    "TODO",
    "GITHUB",
    "LINEAR",
    "CREATE_LINEAR_ISSUE",
    "MUSIC",
    "BROWSER",
    "FORM",
    "VISION",
    "WALLET",
    "MCP",
}


def _load_catalog_doc() -> dict:
    with open(DEFAULT_ELIZA_ACTION_CATALOG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_catalog_file_exists_and_has_expected_actions() -> None:
    doc = _load_catalog_doc()
    assert "actions" in doc
    names = {entry["function"]["name"] for entry in doc["actions"]}
    # Must contain all 13 canonical entries (12 group actions + the
    # CREATE_LINEAR_ISSUE specialization the brief explicitly calls out).
    assert EXPECTED_ACTION_NAMES.issubset(names)
    assert len(doc["actions"]) >= 12


def test_catalog_each_entry_has_source_pointer() -> None:
    doc = _load_catalog_doc()
    for entry in doc["actions"]:
        assert "_source" in entry, f"entry {entry['function']['name']} missing _source"
        assert entry["_source"].endswith(".ts")


def test_catalog_matches_lifeops_manifest_shape() -> None:
    """Sanity-check the JSON's top-level keys mirror the lifeops manifest."""
    catalog_doc = _load_catalog_doc()
    lifeops_path = (
        Path(__file__).resolve().parents[3]
        / "lifeops-bench"
        / "manifests"
        / "actions.manifest.json"
    )
    if not lifeops_path.exists():
        return  # lifeops manifest only exists in development checkouts
    with open(lifeops_path, "r", encoding="utf-8") as fh:
        lifeops_doc = json.load(fh)

    assert "version" in catalog_doc and "version" in lifeops_doc
    assert "actions" in catalog_doc and "actions" in lifeops_doc
    assert isinstance(catalog_doc["actions"], list)
    sample_eliza = catalog_doc["actions"][0]
    sample_lifeops = lifeops_doc["actions"][0]
    assert sample_eliza["type"] == sample_lifeops["type"] == "function"
    assert {"name", "description", "parameters"} <= set(sample_eliza["function"].keys())
    assert {"name", "description", "parameters"} <= set(sample_lifeops["function"].keys())


def test_registry_loads_from_default_path() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    assert len(reg) >= 12
    assert EXPECTED_ACTION_NAMES.issubset(set(reg.action_names))


def test_get_default_registry_caches() -> None:
    reg1 = get_default_registry()
    reg2 = get_default_registry()
    assert reg1 is reg2
    assert reg1 is not None


# --------------------------------------------------------------------------- #
# Schema rendering                                                             #
# --------------------------------------------------------------------------- #


def test_as_bfcl_functions_returns_openai_shaped_dicts() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    functions = reg.as_bfcl_functions()
    assert len(functions) == len(reg)
    for fn in functions:
        assert set(fn.keys()) >= {"name", "description", "parameters"}
        params = fn["parameters"]
        assert params["type"] == "object"
        assert isinstance(params.get("properties"), dict)
        assert isinstance(params.get("required", []), list)


def test_as_openai_tools_wraps_with_function_envelope() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    tools = reg.as_openai_tools()
    assert all(t.get("type") == "function" for t in tools)
    names = {t["function"]["name"] for t in tools}
    assert "PAYMENT" in names


# --------------------------------------------------------------------------- #
# match() / canonical_name()                                                   #
# --------------------------------------------------------------------------- #


def test_match_resolves_canonical_name() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    entry = reg.match("PAYMENT")
    assert entry is not None
    assert entry["function"]["name"] == "PAYMENT"


def test_match_resolves_simile_to_canonical() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    entry = reg.match("REQUEST_PAYMENT")
    assert entry is not None
    assert entry["function"]["name"] == "PAYMENT"


def test_match_is_case_insensitive() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    assert reg.canonical_name("payment") == "PAYMENT"
    assert reg.canonical_name("request_payment") == "PAYMENT"


def test_match_returns_none_for_unknown() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    assert reg.match("not_a_real_action") is None
    assert reg.canonical_name("not_a_real_action") is None
    assert reg.match("") is None


# --------------------------------------------------------------------------- #
# translate_arguments()                                                        #
# --------------------------------------------------------------------------- #


def test_translate_arguments_op_to_action_for_payment() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments("PAYMENT", {"op": "request"})
    assert out == {"action": "request"}


def test_translate_arguments_passes_through_canonical_keys() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments(
        "PAYMENT", {"action": "request", "amount": "3.00"}
    )
    assert out == {"action": "request", "amount": "3.00"}


def test_translate_arguments_works_via_simile() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments("REQUEST_PAYMENT", {"op": "request", "amount": "5.00"})
    assert out == {"action": "request", "amount": "5.00"}


def test_translate_arguments_github_aliases() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments(
        "GITHUB",
        {"op": "issue_create", "repository": "elizaos/eliza", "issue_number": 42},
    )
    assert out["action"] == "issue_create"
    assert out["repo"] == "elizaos/eliza"
    assert out["number"] == 42


def test_translate_arguments_mcp_aliases() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments(
        "MCP",
        {"op": "call_tool", "tool": "filesystem.read", "args": {"path": "/x"}},
    )
    assert out["action"] == "call_tool"
    assert out["toolName"] == "filesystem.read"
    assert out["arguments"] == {"path": "/x"}


def test_translate_arguments_unknown_action_passes_through() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments("not_a_real_action", {"op": "x"})
    assert out == {"op": "x"}


def test_translate_arguments_unknown_keys_passed_through() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    out = reg.translate_arguments("PAYMENT", {"op": "request", "novel_key": 1})
    assert out["action"] == "request"
    assert out["novel_key"] == 1


# --------------------------------------------------------------------------- #
# Adapter integration                                                          #
# --------------------------------------------------------------------------- #


def test_extract_calls_normalizes_eliza_simile_via_registry() -> None:
    """An LLM-emitted simile + 'op' alias should land as canonical PAYMENT/action."""
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    params = {
        "BENCHMARK_ACTION": {
            "arguments": {
                "calls": [
                    {"name": "REQUEST_PAYMENT", "arguments": {"op": "request", "amount": "3.00"}}
                ]
            }
        }
    }
    calls = _extract_calls_from_response("", params, registry=reg)
    assert len(calls) == 1
    assert calls[0].name == "PAYMENT"
    assert calls[0].arguments == {"action": "request", "amount": "3.00"}


def test_extract_calls_canonical_name_passthrough() -> None:
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    params = {
        "BENCHMARK_ACTION": {
            "arguments": {
                "calls": [
                    {"name": "PAYMENT", "arguments": {"action": "check"}}
                ]
            }
        }
    }
    calls = _extract_calls_from_response("", params, registry=reg)
    assert calls[0].name == "PAYMENT"
    assert calls[0].arguments == {"action": "check"}


def test_extract_calls_non_eliza_function_unchanged() -> None:
    """Backward-compat: a non-eliza function call must pass through untouched."""
    reg = ElizaBFCLFunctionRegistry.from_json_file()
    params = {
        "BENCHMARK_ACTION": {
            "arguments": {
                "calls": [
                    {"name": "spotify.play", "arguments": {"artist": "Taylor Swift"}}
                ]
            }
        }
    }
    calls = _extract_calls_from_response("", params, registry=reg)
    assert calls[0].name == "spotify.play"
    assert calls[0].arguments == {"artist": "Taylor Swift"}


def test_extract_calls_without_registry_is_unchanged() -> None:
    """When no registry is supplied, behaviour matches pre-registry adapter."""
    params = {
        "BENCHMARK_ACTION": {
            "arguments": {
                "calls": [
                    {"name": "REQUEST_PAYMENT", "arguments": {"op": "request"}}
                ]
            }
        }
    }
    calls = _extract_calls_from_response("", params)
    # Without a registry we should NOT rewrite the simile
    assert calls[0].name == "REQUEST_PAYMENT"
    assert calls[0].arguments == {"op": "request"}


def test_agent_query_exposes_eliza_catalog_in_live_category(monkeypatch) -> None:
    """In a live BFCL category, the adapter should add eliza tools to the prompt."""
    import asyncio
    from types import SimpleNamespace

    captured: dict = {}

    class Client:
        def reset(self, **_kwargs):
            return {"status": "ok"}

        def send_message(self, text, context):
            captured["context"] = context
            captured["text"] = text
            return SimpleNamespace(
                text="",
                params={
                    "BENCHMARK_ACTION": {
                        "arguments": {
                            "calls": [
                                {"name": "REQUEST_PAYMENT", "arguments": {"op": "request"}}
                            ]
                        }
                    }
                },
                actions=[],
            )

    # Stub the upstream tools formatter so we don't need real FunctionDefinitions
    monkeypatch.setattr(
        bfcl,
        "_bfcl_tools_formatter",
        lambda: lambda _functions: [
            {
                "type": "function",
                "function": {
                    "name": "custom.func",
                    "description": "test",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    agent = bfcl.ElizaBFCLAgent(client=Client())
    agent._initialized = True
    case = SimpleNamespace(
        id="live_simple_1",
        category=SimpleNamespace(value="live_simple"),
        question="Charge me $3",
        functions=[],
        is_relevant=True,
        expected_calls=[],
    )

    calls, _, _ = asyncio.run(agent.query(case))

    # Eliza tools must be present alongside the test's custom function.
    tool_names = {
        (tool.get("function") or {}).get("name")
        for tool in captured["context"]["tools"]
        if isinstance(tool, dict)
    }
    assert "custom.func" in tool_names
    assert "PAYMENT" in tool_names
    assert "SHELL" in tool_names

    # The simile call should be normalized to canonical PAYMENT/action through
    # the default registry the agent loads on init.
    assert calls[0].name == "PAYMENT"
    assert calls[0].arguments == {"action": "request"}


def test_agent_query_does_not_inject_catalog_in_non_live_category(monkeypatch) -> None:
    """Non-live categories must not be polluted with eliza candidate tools."""
    import asyncio
    from types import SimpleNamespace

    captured: dict = {}

    class Client:
        def reset(self, **_kwargs):
            return {"status": "ok"}

        def send_message(self, text, context):
            captured["context"] = context
            return SimpleNamespace(text="", params={}, actions=[])

    monkeypatch.setattr(
        bfcl,
        "_bfcl_tools_formatter",
        lambda: lambda _functions: [
            {
                "type": "function",
                "function": {
                    "name": "custom.func",
                    "description": "test",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    agent = bfcl.ElizaBFCLAgent(client=Client())
    agent._initialized = True
    case = SimpleNamespace(
        id="simple_1",
        category=SimpleNamespace(value="simple"),
        question="x",
        functions=[],
        is_relevant=True,
        expected_calls=[],
    )

    asyncio.run(agent.query(case))

    tool_names = {
        (tool.get("function") or {}).get("name")
        for tool in captured["context"]["tools"]
        if isinstance(tool, dict)
    }
    assert tool_names == {"custom.func"}
