from __future__ import annotations

import importlib
import sys
from types import ModuleType

import pytest


cli = importlib.import_module("benchmarks.suites.abliteration-robustness.cli")


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


def test_expand_prompts_adds_ten_edge_variants_per_prompt() -> None:
    prompts = cli._fallback_prompts(3)

    expanded = cli._expand_prompts(prompts)

    assert len(expanded) == 33
    assert cli._count_prompts(expanded) == {
        "base": 3,
        "edge": 30,
        "total": 33,
        "edge_multiplier": 10,
    }
    assert cli._validate_prompts(expanded) == []


def test_main_count_scenarios_does_not_require_out(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        "sys.argv",
        [
            "abliteration-robustness",
            "--provider",
            "mock",
            "--model",
            "mock",
            "--max-examples",
            "3",
            "--expand-scenarios",
            "--count-scenarios",
        ],
    )

    assert cli.main() == 0

    output = capsys.readouterr().out
    assert '"base": 3' in output
    assert '"edge": 30' in output


def test_huggingface_loader_pins_revision_and_records_provenance(monkeypatch) -> None:
    calls = []

    class Dataset(list):
        _fingerprint = "fixture-fingerprint"

    module = ModuleType("datasets")

    def load_dataset(*args, **kwargs):  # noqa: ANN001, ANN202
        calls.append((args, kwargs))
        return Dataset([{"text": "one"}, {"text": "two"}])

    module.load_dataset = load_dataset  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "datasets", module)

    prompts, provenance = cli._load_prompts_from_hf(
        cli.DEFAULT_DATASET,
        cli.DEFAULT_DATASET_REVISION,
        "test",
        None,
    )

    assert prompts == ["one", "two"]
    assert calls == [
        (
            (cli.DEFAULT_DATASET,),
            {"split": "test", "revision": cli.DEFAULT_DATASET_REVISION},
        )
    ]
    assert provenance["raw_rows"] == 2
    assert provenance["fingerprint"] == "fixture-fingerprint"


def test_huggingface_loader_propagates_data_failure(monkeypatch) -> None:
    module = ModuleType("datasets")

    def load_dataset(*_args, **_kwargs):  # noqa: ANN202
        raise OSError("dataset unavailable")

    module.load_dataset = load_dataset  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "datasets", module)

    with pytest.raises(OSError, match="dataset unavailable"):
        cli._load_prompts_from_hf(
            cli.DEFAULT_DATASET,
            cli.DEFAULT_DATASET_REVISION,
            "test",
            None,
        )
