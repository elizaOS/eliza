"""Smoke + unit tests for the MMLU adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.mmlu import (
    BENCHMARK_ID,
    DATASET_VERSION,
    DEFAULT_MAX_TOKENS,
    SMOKE_FIXTURES,
    MMLURunner,
    _extract_letter,
    _format_question,
    _LETTER_OPTIONS,
    _MMLUFactory,
)


def test_extract_letter_handles_bare_letter() -> None:
    assert _extract_letter("A") == "A"
    assert _extract_letter("B.") == "B"
    assert _extract_letter("C)") == "C"
    assert _extract_letter("d") == "D"


def test_extract_letter_finds_answer_in_sentence() -> None:
    assert _extract_letter("The correct answer is C because…") == "C"
    assert _extract_letter("Answer: B") == "B"


def test_extract_letter_returns_none_when_no_letter() -> None:
    assert _extract_letter("I don't know.") is None
    assert _extract_letter("Because the premise is underspecified.") is None
    assert _extract_letter("") is None


def test_format_question_has_all_choices() -> None:
    item = SMOKE_FIXTURES[0]
    text = _format_question(dict(item))
    assert "A." in text and "B." in text and "C." in text and "D." in text
    assert "Answer:" in text


def test_mmlu_runner_perfect_score(tmp_path: Path) -> None:
    # Mock client returns the correct letter for each fixture in order.
    responses = [
        ["A", "B", "C", "D"][int(item["answer_index"])] for item in SMOKE_FIXTURES  # type: ignore[arg-type]
    ]
    client = MockClient(responses)
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=client,
        model="mock-model",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.benchmark == BENCHMARK_ID
    assert result.n == len(SMOKE_FIXTURES)
    assert result.metrics["score"] == 1.0
    assert result.metrics["correct"] == float(len(SMOKE_FIXTURES))
    assert not result.failures


def test_mmlu_runner_records_failures(tmp_path: Path) -> None:
    # Always answer "A" — only the first fixture (answer C) is wrong; second
    # is wrong (answer B); third is wrong (answer D). So 0/3 correct.
    client = MockClient(["A"])
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=client,
        model="mock-model",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    # First fixture's correct answer is C (index 2), so "A" is wrong.
    assert result.metrics["score"] == 0.0
    assert result.failures, "wrong answers must surface in failures"


def test_mmlu_runner_scores_non_empty_invalid_answers_as_misses(tmp_path: Path) -> None:
    client = MockClient(["I don't know."])
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=client,
        model="mock-model",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )

    assert result.n == len(SMOKE_FIXTURES)
    assert result.metrics["score"] == 0.0
    assert result.raw_json["empty_outputs"] == 0


def test_mmlu_runner_raises_when_all_visible_outputs_empty(tmp_path: Path) -> None:
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))

    with pytest.raises(RuntimeError, match="empty visible output for all"):
        runner.run(
            client=MockClient([""]),
            model="mock-model",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_mmlu_default_token_budget_allows_reasoning_models() -> None:
    # Raised from 256 so a reasoning model's hidden reasoning does not exhaust the
    # budget before the visible answer (the 0.48-vs-0.92 gpt-oss-120b truncation).
    assert DEFAULT_MAX_TOKENS >= 2048


def test_mmlu_runner_partial_empty_outputs_surface_truncation_signal(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    # Alternating empty / non-empty visible output — a reasoning model truncating
    # on some items. These are scored as misses, so the harness MUST surface the
    # empty rate + a loud warning rather than silently reporting a depressed score.
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    with caplog.at_level(logging.WARNING):
        result = runner.run(
            client=MockClient(["", "B"]),
            model="mock-model",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )

    empty = result.raw_json["empty_outputs"]
    assert 0 < empty < result.n, "expected partial (not all) empty outputs"
    assert result.raw_json["empty_output_rate"] == pytest.approx(round(empty / result.n, 4))
    assert any(
        "UNDERSTATES" in record.getMessage() for record in caplog.records
    ), "a partial-empty run must emit the truncation warning"


def test_mmlu_runner_scores_wrong_when_one_generation_fails(
    tmp_path: Path,
) -> None:
    """New contract (was: aborts on the first failure): a single failed
    generation is scored as a miss and the run finishes over the whole dataset
    instead of aborting the remaining examples."""

    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=_FailsOnCalls(_mmlu_correct_letters(), fail_at={1}),
        model="mock-model",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )

    assert result.n == len(SMOKE_FIXTURES)
    # Two of three answered correctly; the failed generation is a miss.
    assert result.metrics["correct"] == 2.0
    assert result.raw_json["generation_errors"] == 1
    assert any(f.get("generation_failed") for f in result.failures)


def test_mmlu_runner_writes_results_file(tmp_path: Path) -> None:
    client = MockClient(["A", "B", "D"])
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    result = runner.run(
        client=client,
        model="mock-model",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    out = result.write(tmp_path / "mmlu-results.json")
    data = json.loads(out.read_text("utf-8"))
    assert data["benchmark"] == BENCHMARK_ID
    assert "score" in data["metrics"]


def test_mmlu_runner_raises_on_zero_examples(tmp_path: Path) -> None:
    runner = MMLURunner(examples=[])
    with pytest.raises(RuntimeError):
        runner.run(
            client=MockClient(["A"]),
            model="m",
            endpoint="http://x",
            output_dir=tmp_path,
            limit=None,
        )


def test_mmlu_cli_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """CLI smoke: --mock + --output writes a results JSON with score 1.0."""

    out_dir = tmp_path / "out"
    rc = main_entry(
        _MMLUFactory(),
        output_filename="mmlu-results.json",
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
    results_file = out_dir / "mmlu-results.json"
    assert results_file.exists()
    data = json.loads(results_file.read_text("utf-8"))
    assert data["metrics"]["score"] == 1.0


def test_mmlu_authored_count_and_mock_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _MMLUFactory(),
        output_filename="mmlu-results.json",
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
        _MMLUFactory(),
        output_filename="mmlu-results.json",
        argv=["--mock", "--output", str(out_dir), "--limit", "1"],
    )
    assert rc == 0
    data = json.loads((out_dir / "mmlu-results.json").read_text("utf-8"))
    assert data["dataset_version"] == DATASET_VERSION
    assert data["n"] == 1
    assert data["metrics"]["score"] == 1.0


class _FailsOnCalls(MockClient):
    """Mock client that raises on a chosen set of call indices.

    ``_idx`` still advances on a failed call so the remaining responses stay
    aligned with example order (MMLU issues exactly one generation per item).
    """

    def __init__(self, responses, fail_at):  # type: ignore[no-untyped-def]
        super().__init__(responses)
        self._fail_at = set(fail_at)

    def generate(self, messages, config):  # type: ignore[no-untyped-def]
        if self._idx in self._fail_at:
            self._idx += 1
            raise OSError("transport unavailable")
        return super().generate(messages, config)


def _mmlu_correct_letters() -> list[str]:
    return [_LETTER_OPTIONS[int(item["answer_index"])] for item in SMOKE_FIXTURES]


def test_mmlu_raises_when_majority_generations_fail(tmp_path: Path) -> None:
    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    with pytest.raises(RuntimeError, match="transport-level error"):
        runner.run(
            client=_FailsOnCalls(_mmlu_correct_letters(), fail_at={1, 2}),
            model="m",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_mmlu_raises_when_all_generations_fail(tmp_path: Path) -> None:
    class AlwaysFails(MockClient):
        def generate(self, messages, config):  # type: ignore[no-untyped-def]
            raise OSError("endpoint down")

    runner = MMLURunner(examples=list(SMOKE_FIXTURES))
    with pytest.raises(RuntimeError, match="transport-level error"):
        runner.run(
            client=AlwaysFails(["unused"]),
            model="m",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )
