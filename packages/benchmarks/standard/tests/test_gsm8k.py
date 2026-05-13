"""Smoke + unit tests for the GSM8K adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import MockClient
from benchmarks.standard._cli import main_entry
from benchmarks.standard.gsm8k import (
    BENCHMARK_ID,
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
