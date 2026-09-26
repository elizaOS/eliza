"""Verifies canonical fixture provenance and fail-closed cross-harness reporting."""

from __future__ import annotations

import importlib.util
import json
from types import SimpleNamespace

import pytest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "eliza-1" / "harness_runner.py"
SPEC = importlib.util.spec_from_file_location("eliza_1_harness_runner", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_explicit_derived_corpus_preserves_dataset_provenance() -> None:
    cases, provenance = RUNNER._load_fixture_bundle(None, "derived")

    assert len(cases) == 59
    assert provenance["origin"] == "dataset"
    # The source dataset lives in the elizaOS monorepo; the count cross-check
    # only runs when ELIZA1_DATASET_ROOT points at a checkout.
    assert provenance["source_count"] in (None, 59)
    assert provenance["derived_from"] == (
        "packages/training/datasets/eliza1-sft-0_6b/test.jsonl"
    )


def test_default_corpus_covers_all_decision_classes() -> None:
    cases, provenance = RUNNER._load_fixture_bundle(None)

    assert len(cases) == 32
    assert provenance["origin"] == "manual"
    assert provenance["label_counts"] == {"RESPOND": 19, "IGNORE": 10, "STOP": 3}
    assert provenance["majority_label_baseline"] == 19 / 32
    assert provenance["decision_class_coverage"] == 3


def test_canonical_output_does_not_repair_prose_or_generic_actions() -> None:
    class Response:
        text = "I should RESPOND to this message."
        actions = ["REPLY"]
        params: dict[str, object] = {}

    assert RUNNER._canonical_output(Response()) == Response.text


def test_canonical_output_accepts_exact_structured_decision() -> None:
    class Response:
        text = ""
        actions = ["BENCHMARK_ACTION"]
        params = {
            "BENCHMARK_ACTION": {
                "arguments": {"shouldRespond": "IGNORE"},
            }
        }

    assert json.loads(RUNNER._canonical_output(Response())) == {
        "shouldRespond": "IGNORE"
    }


def test_transport_failure_writes_report_and_exits_nonzero(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class FailingClient:
        def reset(self, *_args: object) -> None:
            return None

        def send_message(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("transport unavailable")

    monkeypatch.setattr(RUNNER, "_build_client", lambda *_args: (FailingClient(), None))
    output = tmp_path / "result.json"

    exit_code = RUNNER.main(
        [
            "--harness",
            "hermes",
            "--out",
            str(output),
            "--limit",
            "1",
            "--n",
            "1",
        ]
    )

    report = json.loads(output.read_text(encoding="utf-8"))
    assert exit_code == 1
    assert report["corpus"]["full_case_count"] == 32
    assert report["corpus"]["expected_result_count"] == 1
    assert report["cases"][0]["error"] == "RuntimeError: transport unavailable"


def test_every_repetition_gets_an_isolated_task_id(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class Response:
        text = '{"shouldRespond":"RESPOND"}'
        actions: list[str] = []
        params: dict[str, object] = {}

    class RecordingClient:
        def __init__(self) -> None:
            self.reset_ids: list[str] = []

        def reset(self, task_id: str, _benchmark: str) -> None:
            self.reset_ids.append(task_id)

        def send_message(self, *_args: object, **_kwargs: object) -> Response:
            return Response()

    client = RecordingClient()
    monkeypatch.setattr(RUNNER, "_build_client", lambda *_args: (client, None))
    output = tmp_path / "result.json"

    exit_code = RUNNER.main(
        [
            "--harness",
            "hermes",
            "--out",
            str(output),
            "--limit",
            "2",
            "--n",
            "2",
        ]
    )

    assert exit_code == 0
    assert len(client.reset_ids) == 4
    assert len(set(client.reset_ids)) == 4


@pytest.mark.parametrize("usage,expected", [({}, None), ({"completion_tokens": 0}, 0), ({"output_tokens": 7}, 7), ({"completion_tokens": True}, None), ({"completion_tokens": -1}, None)])
def test_token_usage_is_observed_not_guessed(usage, expected):
    response = SimpleNamespace(text='{"shouldRespond":"RESPOND"}', actions=[], params={"usage": usage})
    client = SimpleNamespace(send_message=lambda *args, **kwargs: response)
    text, latency, tokens = RUNNER._send(client, "hermes", "model", {"input": "Hello"}, "case")
    assert tokens == expected
    metric = RUNNER._case_metric(harness="hermes", case={"expected": "RESPOND"}, index=0, raw_output=text, latency_ms=10, tokens=tokens)
    summary = RUNNER._summarize("hermes", [metric])
    assert metric["tokens_generated"] == expected
    assert summary["token_usage_observed_cases"] == (0 if expected is None else 1)
    assert summary["mean_tokens_per_second"] == (None if expected is None else expected * 100)


@pytest.mark.parametrize("raw", [
    '{"shouldRespond":"RESPOND","explanation":"extra"}',
    '{"shouldRespond":["RESPOND"]}',
    'Here is the answer: {"shouldRespond":"RESPOND"}',
    '{"shouldRespond":"RESPOND"} trailing prose',
    '```json\n{"shouldRespond":"RESPOND"}\n```',
])
def test_invalid_schema_or_non_json_output_cannot_score(raw):
    metric = RUNNER._case_metric(harness="hermes", case={"expected": "RESPOND"}, index=0, raw_output=raw, latency_ms=10, tokens=None)
    assert metric["schema_valid"] is False
    assert metric["label_match"] is not True


def test_native_structured_output_preserves_extra_fields_for_grading():
    response = SimpleNamespace(text="", actions=["BENCHMARK_ACTION"], params={"BENCHMARK_ACTION": {"arguments": {"shouldRespond": "RESPOND", "extra": "must not disappear"}}})
    raw = RUNNER._canonical_output(response)
    assert json.loads(raw)["extra"] == "must not disappear"
    metric = RUNNER._case_metric(harness="eliza", case={"expected": "RESPOND"}, index=0, raw_output=raw, latency_ms=10, tokens=None)
    assert metric["schema_valid"] is False


def test_summary_reports_observation_coverage_without_treating_unknown_as_zero():
    summary = RUNNER._summarize("hermes", [{"tokens_generated": None, "tokens_per_second": None}, {"tokens_generated": 5, "tokens_per_second": 10.0}])
    assert summary["mean_tokens_per_second"] == 10.0
    assert summary["token_usage_observed_cases"] == 1


def test_derived_regression_cannot_hide_trivial_majority_baseline():
    _, provenance = RUNNER._load_fixture_bundle(None, "derived")
    assert provenance["decision_class_coverage"] == 1
    assert provenance["majority_label_baseline"] == 1.0
    assert provenance["evaluation_scope"] == "single-class regression"


@pytest.mark.parametrize("first_usage,last_usage,expected", [
    ({"completion_tokens": 5}, {"completion_tokens": 7}, 12),
    ({"completion_tokens": 0}, {"completion_tokens": 0}, 0),
    ({}, {"completion_tokens": 7}, None),
    ({"completion_tokens": 5}, {}, None),
])
def test_explicit_empty_retry_accounts_for_all_attempts(monkeypatch, first_usage, last_usage, expected):
    monkeypatch.setenv("ELIZA_1_EMPTY_RESPONSE_ATTEMPTS", "2")
    responses = iter([
        SimpleNamespace(text="", actions=[], params={"usage": first_usage}),
        SimpleNamespace(text='{"shouldRespond":"RESPOND"}', actions=[], params={"usage": last_usage}),
    ])
    calls = []
    def send(*args, **kwargs):
        calls.append(kwargs["context"])
        return next(responses)
    text, _, tokens = RUNNER._send(SimpleNamespace(send_message=send), "hermes", "model", {"input": "Hello"}, "case")
    assert len(calls) == 2
    assert text == '{"shouldRespond":"RESPOND"}'
    assert tokens == expected


def test_default_attempt_budget_does_not_hide_empty_response(monkeypatch):
    monkeypatch.delenv("ELIZA_1_EMPTY_RESPONSE_ATTEMPTS", raising=False)
    calls = []
    def send(*args, **kwargs):
        calls.append(kwargs["context"])
        return SimpleNamespace(text="", actions=[], params={"usage": {"completion_tokens": 5}})
    text, _, tokens = RUNNER._send(SimpleNamespace(send_message=send), "hermes", "model", {"input": "Hello"}, "case")
    assert len(calls) == 1
    assert text == ""
    assert tokens == 5
