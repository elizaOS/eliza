"""Smoke + unit tests for the MMLU adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.mmlu import (
    BENCHMARK_ID,
    SMOKE_FIXTURES,
    MMLURunner,
    _extract_letter,
    _format_question,
    _MMLUFactory,
)


def test_extract_letter_handles_bare_letter() -> None:
    assert _extract_letter("A") == "A"
    assert _extract_letter("B.") == "B"
    assert _extract_letter("C)") == "C"
    assert _extract_letter("d") == "D"


def test_extract_letter_finds_answer_in_sentence() -> None:
    assert _extract_letter("The correct answer is C because…") == "C"


def test_extract_letter_returns_none_when_no_letter() -> None:
    assert _extract_letter("I don't know.") is None
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
