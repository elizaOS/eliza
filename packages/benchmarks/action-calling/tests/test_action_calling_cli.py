from __future__ import annotations

import importlib


cli = importlib.import_module("benchmarks.action-calling.cli")


def test_score_case_rejects_extra_tool_calls() -> None:
    expected = [{"name": "mail_search", "arguments": {"query": "ACME"}}]
    predicted = [
        {"name": "mail_search", "arguments": {"query": "ACME"}},
        {"name": "mail_delete", "arguments": {"id": "1"}},
    ]

    score = cli._score_case(expected, predicted, tools=[])

    assert score["native_tool_calls_ok"] is True
    assert score["tool_name_match"] is False
    assert score["args_parse_ok"] is False
    assert score["required_keys_ok"] is False
    assert score["arguments_match"] is False


def test_parse_content_tool_calls_reports_json_diagnostic() -> None:
    text = '{"tool_calls":[{"name":"mail_search","arguments":{"query":"ACME"}}]}'

    assert cli._parse_content_tool_calls(text) == [
        {"name": "mail_search", "arguments": {"query": "ACME"}}
    ]


def test_parse_content_tool_calls_reports_hermes_xml_diagnostic() -> None:
    text = '<tool_call>{"name":"mail_search","arguments":{"query":"ACME"}}</tool_call>'

    assert cli._parse_content_tool_calls(text) == [
        {"name": "mail_search", "arguments": {"query": "ACME"}}
    ]


def test_harness_response_to_calls_reads_adapter_tool_calls() -> None:
    class Response:
        text = ""
        actions = ["mail_search"]
        params = {
            "tool_calls": [
                {"name": "mail_search", "arguments": {"query": "ACME"}},
            ],
            "mail_search": {"query": "ACME"},
        }

    calls, text, source = cli._harness_response_to_calls(Response())

    assert calls == [{"name": "mail_search", "arguments": {"query": "ACME"}}]
    assert text == ""
    assert source == "native_tool_calls"


def test_selected_harness_prefers_env_over_provider(monkeypatch) -> None:
    monkeypatch.setenv("BENCHMARK_HARNESS", "hermes")

    assert cli._selected_harness("cerebras") == "hermes"
    assert cli._selected_harness("mock") == ""
