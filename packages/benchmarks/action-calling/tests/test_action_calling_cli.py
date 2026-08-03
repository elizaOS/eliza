"""Exercises the action-calling corpus contract, scorer, and adapter routing."""

from __future__ import annotations

import hashlib
import importlib
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


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


@pytest.mark.parametrize("arguments", ["not-json", "[]", "1", '"value"'])
def test_score_case_rejects_malformed_or_non_object_arguments(arguments: str) -> None:
    predicted = [
        cli._normalize_tool_call({"name": "mail_search", "arguments": arguments})
    ]
    assert predicted[0] is not None

    score = cli._score_case(
        [{"name": "mail_search", "arguments": {"query": "ACME"}}],
        predicted,
        tools=[],
    )

    assert score["args_parse_ok"] is False
    assert score["required_keys_ok"] is False
    assert score["arguments_match"] is False


def test_geometric_mean_is_zero_when_any_required_metric_is_zero() -> None:
    assert cli._geometric_mean([1.0, 1.0, 0.0, 1.0, 1.0]) == 0.0


@pytest.mark.parametrize(
    ("expected_arguments", "predicted_arguments"),
    [
        ({"count": 1}, {"count": "1"}),
        ({"enabled": True}, {"enabled": 1}),
        ({"count": 1}, {"count": True}),
        (
            {"config": {"items": [1, {"enabled": True}]}},
            {"config": {"items": [1, {"enabled": 1}]}},
        ),
        ({"items": [1, 2]}, {"items": [1, 2, 3]}),
        ({"query": "ACME"}, {"query": "ACME", "limit": 10}),
    ],
    ids=(
        "stringified-number",
        "bool-versus-int",
        "int-versus-bool",
        "nested-type-mismatch",
        "list-length-mismatch",
        "extra-argument",
    ),
)
def test_score_case_rejects_non_exact_json_arguments(
    expected_arguments: dict[str, object],
    predicted_arguments: dict[str, object],
) -> None:
    score = cli._score_case(
        [{"name": "submit", "arguments": expected_arguments}],
        [{"name": "submit", "arguments": predicted_arguments}],
        tools=[],
    )

    assert score["arguments_match"] is False


def test_score_case_accepts_equal_non_boolean_json_numbers() -> None:
    score = cli._score_case(
        [{"name": "submit", "arguments": {"count": 1}}],
        [{"name": "submit", "arguments": {"count": 1.0}}],
        tools=[],
    )

    assert score["arguments_match"] is True


def test_score_case_accepts_equivalent_iso_datetimes() -> None:
    score = cli._score_case(
        [{"name": "submit", "arguments": {"at": "2026-07-21T12:00:00Z"}}],
        [
            {
                "name": "submit",
                "arguments": {"at": "2026-07-21T08:00:00-04:00"},
            }
        ],
        tools=[],
    )

    assert score["arguments_match"] is True


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


def test_harness_generation_keeps_the_reset_task_identity(monkeypatch) -> None:
    case = cli._load_cases(cli.SMOKE_TEST, 1)[0]
    contexts: list[dict[str, object]] = []

    class FakeClient:
        def send_message(
            self, text: str, context: dict[str, object]
        ) -> types.SimpleNamespace:
            del text
            contexts.append(context)
            expected = case.expected_calls[0]
            return types.SimpleNamespace(
                text="",
                actions=[expected["name"]],
                params={"tool_calls": [expected]},
            )

    monkeypatch.setenv("BENCHMARK_HARNESS", "eliza")
    predicted, _, _, _ = cli._generate(
        FakeClient(),
        "cerebras",
        "test-model",
        case,
        "action-calling-run-7-case-0",
        256,
        0.0,
        "auto",
    )

    assert predicted == case.expected_calls
    assert contexts[0]["task_id"] == "action-calling-run-7-case-0"


def test_task_ids_are_run_scoped_and_case_distinct(monkeypatch) -> None:
    cases = cli._expand_cases(cli._load_cases(cli.SMOKE_TEST, 1))
    monkeypatch.setenv("BENCHMARK_RUN_ID", "run-123")

    task_ids = [cli._task_id(case, index) for index, case in enumerate(cases)]

    assert len(task_ids) == len(set(task_ids))
    assert all(task_id.startswith("action-calling-run-123-") for task_id in task_ids)


def test_selected_harness_prefers_env_over_provider(monkeypatch) -> None:
    monkeypatch.setenv("BENCHMARK_HARNESS", "hermes")

    assert cli._selected_harness("cerebras") == "hermes"
    assert cli._selected_harness("mock") == ""


def test_hermes_factory_uses_subscription_identity_without_legacy_mode(
    monkeypatch,
) -> None:
    cli._ensure_adapter_path("hermes-adapter")
    import hermes_adapter.client as client_module

    captured: dict[str, object] = {}

    class FakeHermesClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

        def wait_until_ready(self, timeout: int) -> None:
            captured["ready_timeout"] = timeout

    monkeypatch.setattr(client_module, "HermesClient", FakeHermesClient)
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")

    client = cli._make_harness_client(
        "hermes",
        types.SimpleNamespace(
            provider="openai",
            model="ignored",
            base_url="http://127.0.0.1:43123/v1",
        ),
    )

    assert isinstance(client, FakeHermesClient)
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "base_url": "http://127.0.0.1:43123/v1",
        "ready_timeout": 120,
    }


def test_expand_cases_adds_ten_edge_variants_per_case() -> None:
    cases = cli._load_cases(cli.SMOKE_TEST, 100)

    expanded = cli._expand_cases(cases)

    assert len(cases) == 1
    assert len(expanded) == 11
    assert len({cli._case_id(case, index) for index, case in enumerate(expanded)}) == 11
    assert all(
        expanded[index].expected_calls == cases[0].expected_calls
        for index in range(1, 11)
    )
    assert cli._validate_cases(expanded) == []


def test_official_corpus_recovers_all_opaque_tasks_contracts() -> None:
    cases = cli._load_cases(cli.DEFAULT_TEST, None)

    assert len(cases) == 63
    assert {
        cli._as_dict(
            cli._as_dict(case.record.get("metadata")).get("action_calling_contract")
        ).get("schema_source")
        for case in cases
    } == {
        "direct_json_schema",
        "wrapped_json_schema",
        "inferred_from_answer_shape",
    }
    assert all(
        case.tools[0]["function"]["description"]
        == cli.STRUCTURED_OUTPUT_TOOL_DESCRIPTION
        for case in cases
    )
    assert all(
        case.expected_calls[0]["arguments"]
        == json.loads(case.record["output"]["planner"]["text"])
        for case in cases
    )
    assert all(
        set(case.expected_calls[0]["arguments"])
        <= set(case.tools[0]["function"]["parameters"]["properties"])
        for case in cases
    )
    provenance = cli._contract_provenance(cases, cli._expand_cases(cases))
    assert provenance == {
        "contract_version": "structured-output-tool-v2",
        "recovered_opaque_tasks_contract_count": 63,
        "recovered_schema_sources": {
            "direct_json_schema": 45,
            "inferred_from_answer_shape": 4,
            "wrapped_json_schema": 14,
        },
        "base_case_manifest_sha256": (
            "d9eb9ddc74f23838960a81cc78e782ebd3127e849ee7048e748a13dacf58a58b"
        ),
        "evaluated_case_manifest_sha256": (
            "147423d1dfc422cfab96670d1248b890344d56784e8940de05351620517609a9"
        ),
        "evaluated_case_id_manifest_sha256": (
            "51788d8fa8207b067597b845e9c5e83db9ab0de1f4d235d98a146b47a577441f"
        ),
    }


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


def test_live_default_dataset_fails_closed_when_official_corpus_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    missing = tmp_path / "missing-official.jsonl"
    monkeypatch.setattr(cli, "DEFAULT_TEST", missing)

    with pytest.raises(SystemExit, match="live harness runs do not fall back"):
        cli._resolve_test_file(missing, provider="claude-subscription")


def test_mock_default_dataset_may_use_smoke_fixture(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    missing = tmp_path / "missing-official.jsonl"
    monkeypatch.setattr(cli, "DEFAULT_TEST", missing)

    assert cli._resolve_test_file(missing, provider="mock") == cli.SMOKE_TEST.resolve()


def test_live_explicit_test_file_is_allowed(tmp_path: Path) -> None:
    explicit = tmp_path / "explicit.jsonl"
    explicit.write_text('{"id":"explicit"}\n', encoding="utf-8")

    assert (
        cli._resolve_test_file(
            explicit,
            provider="claude-subscription",
        )
        == explicit.resolve()
    )


def test_dataset_identity_records_resolved_path_hash_and_row_count(
    tmp_path: Path,
) -> None:
    dataset = tmp_path / "dataset.jsonl"
    raw = b'{"id":1}\n\n{"id":2}\n'
    dataset.write_bytes(raw)

    assert cli._dataset_identity(dataset) == {
        "resolved_path": str(dataset.resolve()),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "row_count": 2,
    }


def test_loader_fails_closed_on_invalid_json(tmp_path: Path) -> None:
    dataset = tmp_path / "broken.jsonl"
    dataset.write_text("{broken\n", encoding="utf-8")

    with pytest.raises(ValueError, match="invalid action-calling JSON"):
        cli._load_cases(dataset, None)


def test_real_cli_defaults_to_all_eligible_cases() -> None:
    args = cli._build_argparser().parse_args(
        ["--provider", "openai", "--model", "model"]
    )

    assert args.max_examples is None


def test_action_calling_openclaw_factory_uses_native_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeOpenClawClient:
        def __init__(self, **kwargs: object) -> None:
            captured["kwargs"] = kwargs

        def wait_until_ready(self, timeout: float) -> None:
            captured["timeout"] = timeout

    package = types.ModuleType("openclaw_adapter")
    client_module = types.ModuleType("openclaw_adapter.client")
    client_module.OpenClawClient = FakeOpenClawClient
    monkeypatch.setitem(sys.modules, "openclaw_adapter", package)
    monkeypatch.setitem(sys.modules, "openclaw_adapter.client", client_module)
    monkeypatch.setattr(cli, "_ensure_adapter_path", lambda _dirname: None)
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")
    args = cli._build_argparser().parse_args(
        [
            "--provider",
            "openai",
            "--model",
            "ignored",
            "--base-url",
            "http://127.0.0.1:43123/v1",
        ]
    )

    client = cli._make_harness_client("openclaw", args)

    assert isinstance(client, FakeOpenClawClient)
    assert captured["kwargs"] == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "base_url": "http://127.0.0.1:43123/v1",
    }
    assert captured["timeout"] == 120


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
                                            "arguments": json.dumps(
                                                {"query": "ACME invoice"}
                                            ),
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

    summary = json.loads(
        (out_dir / "action-calling-results.json").read_text(encoding="utf-8")
    )
    assert summary["provider"] == "cerebras"
    assert summary["generation_source"] == "native_tool_calls"
    assert summary["metrics"]["score"] == 1.0
    assert summary["n"] == 1
    assert summary["dataset_provenance"] == {
        "resolved_path": str(cli.SMOKE_TEST.resolve()),
        "sha256": hashlib.sha256(cli.SMOKE_TEST.read_bytes()).hexdigest(),
        "row_count": 1,
        "contract_version": "structured-output-tool-v2",
        "recovered_opaque_tasks_contract_count": 0,
        "recovered_schema_sources": {},
        "base_case_manifest_sha256": (
            "420323862954957ef1801c4b0af82b0fdb06df9f4b607033bfed5a532a6fb905"
        ),
        "evaluated_case_manifest_sha256": (
            "420323862954957ef1801c4b0af82b0fdb06df9f4b607033bfed5a532a6fb905"
        ),
        "evaluated_case_id_manifest_sha256": cli._case_id_manifest_sha256(
            cli._load_cases(cli.SMOKE_TEST, None)
        ),
        "loaded_base_case_count": 1,
        "evaluated_case_count": 1,
        "scenario_expansion": False,
    }
    assert summary["counts"] == {
        "native_tool_calls_ok": 1,
        "tool_name_match": 1,
        "args_parse_ok": 1,
        "required_keys_ok": 1,
        "arguments_match": 1,
    }
    assert summary["case_outcomes"] == [
        {
            "case_id": "action-calling-smoke",
            "messages": [
                {
                    "role": "user",
                    "content": "Find recent invoice emails for ACME.",
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "mail_search",
                        "description": "Search email messages.",
                        "parameters": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                            "required": ["query"],
                            "additionalProperties": False,
                        },
                    },
                }
            ],
            "expected_tool_calls": [
                {
                    "name": "mail_search",
                    "arguments": {"query": "ACME invoice"},
                }
            ],
            "predicted_tool_calls": [
                {
                    "id": "call_action_calling_smithers",
                    "name": "mail_search",
                    "arguments": {"query": "ACME invoice"},
                }
            ],
            "generation_source": "native_tool_calls",
            "native_tool_calls_ok": True,
            "tool_name_match": True,
            "args_parse_ok": True,
            "required_keys_ok": True,
            "arguments_match": True,
        }
    ]
    assert received
    assert received[0]["model"] == "local-smithers"
    assert received[0]["_path"] in {"/v1/chat/completions", "/v1/responses"}
