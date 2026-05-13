"""Smoke + unit tests for the MT-Bench adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.mt_bench import (
    BENCHMARK_ID,
    SMOKE_QUESTIONS,
    MTBenchRunner,
    _extract_rating,
    _build_judge_prompt,
    _build_strict_judge_prompt,
    _MTBenchFactory,
)


def test_extract_rating_matches_lmsys_form() -> None:
    text = "The answer is reasonable.\nRating: [[7]]"
    assert _extract_rating(text) == 7.0


def test_extract_rating_handles_two_digit() -> None:
    assert _extract_rating("Rating: [[10]]") == 10.0


def test_extract_rating_accepts_common_judge_variants() -> None:
    assert _extract_rating("Final rating: 8/10") == 8.0
    assert _extract_rating("Score = [6]") == 6.0


def test_extract_rating_rejects_out_of_range() -> None:
    assert _extract_rating("Rating: [[11]]") is None
    assert _extract_rating("Rating: [[0]]") is None


def test_extract_rating_returns_none_on_no_match() -> None:
    assert _extract_rating("I give it a high mark") is None


def test_build_judge_prompt_includes_turn_marker() -> None:
    prompt = _build_judge_prompt("Q?", "A.", turn=2)
    assert "turn 2" in prompt
    assert "Q?" in prompt and "A." in prompt
    assert 'First line only: "Rating: [[N]]"' in prompt


def test_build_strict_judge_prompt_requests_rating_only() -> None:
    prompt = _build_strict_judge_prompt("Q?", "A.", turn=1)
    assert "return only the rating line" in prompt
    assert '"Rating: [[N]]"' in prompt


def test_mt_bench_runner_scores_mean_rating(tmp_path: Path) -> None:
    # Candidate echoes any text; judge returns "Rating: [[8]]" each time.
    candidate = MockClient(["Mock answer" for _ in range(len(SMOKE_QUESTIONS) * 2)])
    judge = MockClient(["Rating: [[8]]" for _ in range(len(SMOKE_QUESTIONS) * 2)])
    runner = MTBenchRunner(
        judge=judge,
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS),
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.benchmark == BENCHMARK_ID
    # 3 questions * 2 turns = 6 ratings, each 8/10 = 0.8 score.
    assert result.metrics["score"] == 0.8
    assert result.metrics["mean_rating"] == 8.0
    assert result.metrics["turn_1_mean"] == 8.0
    assert result.metrics["turn_2_mean"] == 8.0
    assert result.n == len(SMOKE_QUESTIONS) * 2


def test_mt_bench_runner_separates_turn_means(tmp_path: Path) -> None:
    candidate = MockClient(["x"])
    # Alternate judge ratings so turn-1 and turn-2 differ.
    # Per question loop the runner calls judge(turn=1) then judge(turn=2).
    judge_responses = ["Rating: [[10]]", "Rating: [[6]]"] * len(SMOKE_QUESTIONS)
    runner = MTBenchRunner(
        judge=MockClient(judge_responses),
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS),
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    assert result.metrics["turn_1_mean"] == 10.0
    assert result.metrics["turn_2_mean"] == 6.0
    assert result.metrics["mean_rating"] == 8.0


def test_mt_bench_runner_skips_invalid_judge(tmp_path: Path) -> None:
    candidate = MockClient(["x"])
    # Judge returns malformed ratings sometimes; runner must drop them but
    # still emit a result if any valid rating survives.
    judge_responses = [
        "Rating: [[5]]",
        "garbage with no rating",
        "still garbage with no rating",
    ] * len(SMOKE_QUESTIONS)
    runner = MTBenchRunner(
        judge=MockClient(judge_responses),
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS),
    )
    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )
    # Only the turn-1 ratings (5) survived; turn-2 were dropped.
    assert result.metrics["mean_rating"] == 5.0
    assert result.metrics["turn_2_mean"] == 0.0


def test_mt_bench_runner_retries_unparseable_judge_rating(tmp_path: Path) -> None:
    candidate = MockClient(["x", "y"])
    judge = MockClient(["not parseable", "Rating: [[6]]", "still not parseable", "Rating: [[8]]"])
    runner = MTBenchRunner(
        judge=judge,
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS[:1]),
    )

    result = runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )

    assert result.n == 2
    assert result.metrics["mean_rating"] == 7.0


def test_mt_bench_cli_end_to_end(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _MTBenchFactory(),
        output_filename="mt-bench-results.json",
        argv=[
            "--mock",
            "--provider",
            "openai",
            "--model",
            "cand",
            "--judge-model",
            "judge",
            "--output",
            str(out_dir),
            "--api-key-env",
            "DOES_NOT_EXIST",
            "--judge-api-key-env",
            "DOES_NOT_EXIST",
        ],
    )
    assert rc == 0
    data = json.loads((out_dir / "mt-bench-results.json").read_text("utf-8"))
    # Mock judge always returns Rating [[8]] → score 0.8.
    assert data["metrics"]["score"] == 0.8
    assert data["benchmark"] == BENCHMARK_ID
