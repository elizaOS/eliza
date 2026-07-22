"""Verifies canonical fixture provenance and fail-closed cross-harness reporting."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "harness_runner.py"
SPEC = importlib.util.spec_from_file_location("eliza_1_harness_runner", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_default_corpus_is_complete_dataset_derived_split() -> None:
    cases, provenance = RUNNER._load_fixture_bundle(None)

    assert len(cases) == 59
    assert provenance["origin"] == "dataset"
    assert provenance["source_count"] == 59
    assert provenance["derived_from"] == (
        "packages/training/datasets/eliza1-sft-0_6b/test.jsonl"
    )


def test_manual_probe_corpus_remains_explicitly_selectable() -> None:
    cases, provenance = RUNNER._load_fixture_bundle(None, "manual")

    assert len(cases) == 32
    assert provenance["origin"] == "manual"


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
    assert report["corpus"]["full_case_count"] == 59
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
