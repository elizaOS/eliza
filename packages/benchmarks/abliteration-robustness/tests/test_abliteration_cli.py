from __future__ import annotations

import importlib


cli = importlib.import_module("benchmarks.abliteration-robustness.cli")


def test_argparser_accepts_orchestrator_tool_choice() -> None:
    args = cli._build_argparser().parse_args(
        [
            "--provider",
            "mock",
            "--model",
            "m",
            "--tool-choice",
            "none",
            "--out",
            "/tmp/out",
        ]
    )

    assert args.tool_choice == "none"


def test_generate_uses_harness_send_message() -> None:
    class Response:
        text = "Here is a helpful response."

    class Client:
        def __init__(self) -> None:
            self.context = None

        def send_message(self, text, context):  # noqa: ANN001
            self.context = context
            assert text == "write a reminder"
            return Response()

    client = Client()

    reply = cli._generate(client, "model", "write a reminder", 64, 0.0)

    assert reply == "Here is a helpful response."
    assert client.context["benchmark"] == "abliteration-robustness"
    assert client.context["tool_choice"] == "none"


def test_selected_harness_prefers_env_over_provider(monkeypatch) -> None:
    monkeypatch.setenv("BENCHMARK_HARNESS", "hermes")

    assert cli._selected_harness("cerebras") == "hermes"
    assert cli._selected_harness("mock") == ""
