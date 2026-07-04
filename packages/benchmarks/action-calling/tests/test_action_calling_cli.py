from __future__ import annotations

import importlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


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


def test_expand_cases_adds_ten_edge_variants_per_case() -> None:
    cases = cli._load_cases(cli.SMOKE_TEST, 100)

    expanded = cli._expand_cases(cases)

    assert len(cases) == 1
    assert len(expanded) == 11
    assert len({cli._case_id(case, index) for index, case in enumerate(expanded)}) == 11
    assert all(expanded[index].expected_calls == cases[0].expected_calls for index in range(1, 11))
    assert cli._validate_cases(expanded) == []


def test_main_count_scenarios_does_not_require_out(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        "sys.argv",
        [
            "action-calling",
            "--provider",
            "mock",
            "--model",
            "mock",
            "--test-file",
            str(cli.SMOKE_TEST),
            "--max-examples",
            "1",
            "--expand-scenarios",
            "--count-scenarios",
        ],
    )

    assert cli.main() == 0

    output = capsys.readouterr().out
    assert '"base": 1' in output
    assert '"edge": 10' in output


def test_main_runs_smithers_harness_against_local_server(
    monkeypatch,
    tmp_path: Path,
) -> None:
    packages_root = Path(__file__).resolve().parents[3]
    smithers_test_helpers = packages_root / "benchmarks" / "smithers-adapter" / "tests"
    if str(smithers_test_helpers) not in sys.path:
        sys.path.insert(0, str(smithers_test_helpers))
    from live_harness import materialize_live_smithers_install

    install_dir = tmp_path / "smithers-install"
    materialize_live_smithers_install(install_dir)
    received: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            body["_path"] = self.path
            received.append(body)
            if self.path.endswith("/responses"):
                payload = {
                    "id": "resp-action-calling-smithers",
                    "object": "response",
                    "created_at": 1,
                    "status": "completed",
                    "model": body.get("model", "local-smithers"),
                    "output": [
                        {
                            "id": "fc-action-calling-smithers",
                            "type": "function_call",
                            "status": "completed",
                            "call_id": "call_action_calling_smithers",
                            "name": "mail_search",
                            "arguments": json.dumps({"query": "ACME invoice"}),
                        }
                    ],
                    "usage": {
                        "input_tokens": 13,
                        "output_tokens": 4,
                        "total_tokens": 17,
                    },
                }
            else:
                payload = {
                    "id": "chatcmpl-action-calling-smithers",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body.get("model", "local-smithers"),
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_action_calling_smithers",
                                        "type": "function",
                                        "function": {
                                            "name": "mail_search",
                                            "arguments": json.dumps({"query": "ACME invoice"}),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 13,
                        "completion_tokens": 4,
                        "total_tokens": 17,
                    },
                }
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("BENCHMARK_HARNESS", "smithers")
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "local-key")
    monkeypatch.setenv("SMITHERS_DIR", str(install_dir))
    out_dir = tmp_path / "out"
    try:
        monkeypatch.setattr(
            "sys.argv",
            [
                "action-calling",
                "--provider",
                "cerebras",
                "--model",
                "local-smithers",
                "--base-url",
                f"http://127.0.0.1:{server.server_port}/v1",
                "--test-file",
                str(cli.SMOKE_TEST),
                "--max-examples",
                "1",
                "--out",
                str(out_dir),
            ],
        )
        assert cli.main() == 0
    finally:
        server.shutdown()
        thread.join(timeout=5)

    summary = json.loads((out_dir / "action-calling-results.json").read_text(encoding="utf-8"))
    assert summary["provider"] == "cerebras"
    assert summary["generation_source"] == "native_tool_calls"
    assert summary["metrics"]["score"] == 1.0
    assert summary["n"] == 1
    assert received
    assert received[0]["model"] == "local-smithers"
    assert received[0]["_path"] in {"/v1/chat/completions", "/v1/responses"}
