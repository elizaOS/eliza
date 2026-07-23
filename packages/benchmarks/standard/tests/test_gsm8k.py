"""Smoke + unit tests for the GSM8K adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.gsm8k import (
    BENCHMARK_ID,
    DATASET_VERSION,
    SMOKE_FIXTURES,
    GSM8KRunner,
    _gold_from_answer,
    _parse_final_answer,
    _GSM8KFactory,
)


def test_parse_final_answer_marker_form() -> None:
    assert _parse_final_answer("Let's see... #### 42") == 42


def test_parse_final_answer_with_commas() -> None:
    assert _parse_final_answer("#### 1,234") == 1234


def test_parse_final_answer_accepts_only_integral_decimals() -> None:
    assert _parse_final_answer("#### 42.0") == 42
    assert _parse_final_answer("#### 42.5") is None
    assert _parse_final_answer("The final value is 42.5") is None


def test_parse_final_answer_negative() -> None:
    assert _parse_final_answer("#### -7") == -7


def test_parse_final_answer_falls_back_to_last_number() -> None:
    assert _parse_final_answer("I think the answer is 19.") == 19


def test_parse_final_answer_returns_none_on_empty() -> None:
    assert _parse_final_answer("") is None


def test_gold_from_answer_uses_marker() -> None:
    assert _gold_from_answer("step 1: 2+3 = 5\n#### 5") == 5


def test_gsm8k_perfect_score(tmp_path: Path) -> None:
    # Echo the canonical answer per fixture.
    responses = [str(item["answer"]) for item in SMOKE_FIXTURES]
    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=MockClient(responses),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.benchmark == BENCHMARK_ID
    assert result.metrics["score"] == 1.0
    assert result.metrics["format_ok"] == 1.0


def test_gsm8k_partial_credit(tmp_path: Path) -> None:
    # First two correct, third wrong.
    responses = [
        str(SMOKE_FIXTURES[0]["answer"]),
        str(SMOKE_FIXTURES[1]["answer"]),
        "I have no idea but maybe #### 99",
    ]
    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=MockClient(responses),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["score"] == pytest.approx(2 / 3, rel=1e-3)
    assert result.failures, "wrong answer must surface"


def test_gsm8k_format_ok_tracks_marker_presence(tmp_path: Path) -> None:
    # All correct integers, but only the last includes the marker.
    responses = ["7", "150", str(SMOKE_FIXTURES[2]["answer"])]
    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=MockClient(responses),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["score"] == 1.0
    # Only the third response had ####.
    assert result.metrics["format_ok"] == pytest.approx(1 / 3, rel=1e-3)


def test_gsm8k_runner_scores_wrong_when_one_generation_fails(
    tmp_path: Path,
) -> None:
    """New contract (was: aborts on the first failure): a single failed
    generation is scored wrong and the run finishes over the whole dataset
    instead of aborting the remaining examples."""

    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=_FailsOnCalls(_gsm8k_answers(), fail_at={1}),
        model="m",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )

    assert result.n == len(SMOKE_FIXTURES)
    # Two of three scored correctly; the failed generation is wrong.
    assert result.metrics["correct"] == 2.0
    assert result.raw_json["generation_errors"] == 1
    assert any(f.get("generation_failed") for f in result.failures)


def test_gsm8k_cli_end_to_end(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _GSM8KFactory(),
        output_filename="gsm8k-results.json",
        argv=[
            "--mock",
            "--provider",
            "openai",
            "--model",
            "mock",
            "--output",
            str(out_dir),
            "--api-key-env",
            "DOES_NOT_EXIST",
        ],
    )
    assert rc == 0
    data = json.loads((out_dir / "gsm8k-results.json").read_text("utf-8"))
    assert data["metrics"]["score"] == 1.0


def test_gsm8k_authored_count_and_mock_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _GSM8KFactory(),
        output_filename="gsm8k-results.json",
        argv=[
            "--mock",
            "--output",
            str(out_dir),
            "--limit",
            "1",
            "--count-scenarios",
            "--validate-scenarios",
        ],
    )
    assert rc == 0
    assert '"total": 1' in capsys.readouterr().out

    rc = main_entry(
        _GSM8KFactory(),
        output_filename="gsm8k-results.json",
        argv=["--mock", "--output", str(out_dir), "--limit", "1"],
    )
    assert rc == 0
    data = json.loads((out_dir / "gsm8k-results.json").read_text("utf-8"))
    assert data["dataset_version"] == DATASET_VERSION
    assert data["n"] == 1
    assert data["metrics"]["score"] == 1.0


class _FailsOnCalls(MockClient):
    """Mock client that raises on a chosen set of call indices.

    ``_idx`` still advances on a failed call so the remaining responses stay
    aligned with example order (GSM8K issues exactly one generation per item).
    """

    def __init__(self, responses, fail_at):  # type: ignore[no-untyped-def]
        super().__init__(responses)
        self._fail_at = set(fail_at)

    def generate(self, messages, config):  # type: ignore[no-untyped-def]
        if self._idx in self._fail_at:
            self._idx += 1
            raise OSError("transport unavailable")
        return super().generate(messages, config)


def _gsm8k_answers() -> list[str]:
    return [str(item["answer"]) for item in SMOKE_FIXTURES]


def test_gsm8k_raises_when_majority_generations_fail(tmp_path: Path) -> None:
    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    with pytest.raises(RuntimeError, match="transport-level error"):
        runner.run(
            client=_FailsOnCalls(_gsm8k_answers(), fail_at={1, 2}),
            model="m",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_gsm8k_raises_when_all_generations_fail(tmp_path: Path) -> None:
    class AlwaysFails(MockClient):
        def generate(self, messages, config):  # type: ignore[no-untyped-def]
            raise OSError("endpoint down")

    runner = GSM8KRunner(examples=list(SMOKE_FIXTURES))
    with pytest.raises(RuntimeError, match="transport-level error"):
        runner.run(
            client=AlwaysFails(["unused"]),
            model="m",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )
