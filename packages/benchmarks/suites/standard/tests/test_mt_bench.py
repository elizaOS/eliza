"""Smoke + unit tests for the MT-Bench adapter."""

from __future__ import annotations

import json
import sys
from types import ModuleType
from pathlib import Path

import pytest

import argparse

from benchmarks.standard._base import (
    ENDPOINT_ENV_CHAIN,
    HTTPOpenAICompatibleClient,
    MockClient,
)
from benchmarks.standard._cli import main_entry
from benchmarks.standard.mt_bench import (
    BENCHMARK_ID,
    DEFAULT_JUDGE_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
    SMOKE_QUESTIONS,
    MTBenchRunner,
    _extract_rating,
    _build_judge_prompt,
    _build_strict_judge_prompt,
    _load_dataset_questions,
    _MTBenchFactory,
)


def _judgment_rows(count: int = 80) -> list[dict[str, object]]:
    return [
        {
            "question_id": question_id,
            "conversation_a": [
                {"role": "user", "content": f"turn one {question_id}"},
                {"role": "assistant", "content": "candidate response"},
                {"role": "user", "content": f"turn two {question_id}"},
                {"role": "assistant", "content": "candidate response"},
            ],
        }
        for question_id in range(81, 81 + count)
    ]


def _install_fake_datasets(monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, object]]) -> None:
    module = ModuleType("datasets")
    module.load_dataset = lambda *_args, **_kwargs: rows  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "datasets", module)


def test_mt_bench_loader_reconstructs_all_official_questions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_datasets(monkeypatch, _judgment_rows())

    questions = _load_dataset_questions(limit=None)

    assert len(questions) == 80
    assert questions[0] == {
        "question_id": 81,
        "category": "writing",
        "turns": ("turn one 81", "turn two 81"),
    }
    assert questions[10]["category"] == "roleplay"
    assert questions[-1]["category"] == "humanities"


def test_mt_bench_loader_rejects_an_incomplete_corpus(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_datasets(monkeypatch, _judgment_rows(79))

    with pytest.raises(RuntimeError, match="expected 80 unique questions, loaded 79"):
        _load_dataset_questions(limit=None)


def test_extract_rating_matches_lmsys_form() -> None:
    text = "The answer is reasonable.\nRating: [[7]]"
    assert _extract_rating(text) == 7.0


def test_extract_rating_handles_two_digit() -> None:
    assert _extract_rating("Rating: [[10]]") == 10.0


def test_extract_rating_accepts_common_judge_variants() -> None:
    assert _extract_rating("Final rating: 8/10") == 8.0
    assert _extract_rating("Score = [6]") == 6.0
    assert _extract_rating("I would give it a 9/10.") == 9.0
    assert _extract_rating("7") == 7.0


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


def test_mt_bench_runner_rejects_invalid_judge_rating(tmp_path: Path) -> None:
    candidate = MockClient(["x"])
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

    with pytest.raises(RuntimeError, match="no valid rating.*after retry"):
        runner.run(
            client=candidate,
            model="cand",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


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


def test_mt_bench_runner_raises_when_all_candidate_outputs_empty(tmp_path: Path) -> None:
    candidate = MockClient([""])
    judge = MockClient(["Rating: [[1]]" for _ in range(len(SMOKE_QUESTIONS) * 2)])
    runner = MTBenchRunner(
        judge=judge,
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS),
    )

    with pytest.raises(RuntimeError, match="empty visible output for all"):
        runner.run(
            client=candidate,
            model="cand",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_mt_bench_runner_aborts_when_candidate_turn_fails(tmp_path: Path) -> None:
    class FailsOnSecondCall(MockClient):
        def generate(self, messages, config):  # type: ignore[no-untyped-def]
            if self._idx == 1:
                raise OSError("transport unavailable")
            return super().generate(messages, config)

    runner = MTBenchRunner(
        judge=MockClient(["Rating: [[8]]"]),
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS[:1]),
    )

    with pytest.raises(RuntimeError, match="turn 2"):
        runner.run(
            client=FailsOnSecondCall(["answer"]),
            model="cand",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_mt_bench_runner_aborts_when_judge_transport_fails(tmp_path: Path) -> None:
    class FailingJudge(MockClient):
        def generate(self, messages, config):  # type: ignore[no-untyped-def]
            raise OSError("judge unavailable")

    runner = MTBenchRunner(
        judge=FailingJudge(["unused"]),
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS[:1]),
    )

    with pytest.raises(RuntimeError, match="judge generation failed"):
        runner.run(
            client=MockClient(["answer"]),
            model="cand",
            endpoint="http://mock",
            output_dir=tmp_path,
            limit=None,
        )


def test_mt_bench_default_token_budgets_allow_reasoning_models() -> None:
    assert DEFAULT_MAX_TOKENS >= 4096
    assert DEFAULT_JUDGE_MAX_TOKENS >= 1024


def test_mt_bench_candidate_temperature_is_configurable(tmp_path: Path) -> None:
    class RecordingCandidate(MockClient):
        temperatures: list[float]

        def __init__(self) -> None:
            super().__init__(["x", "y"])
            self.temperatures = []

        def generate(self, messages, config):  # type: ignore[no-untyped-def]
            self.temperatures.append(config.temperature)
            return super().generate(messages, config)

    candidate = RecordingCandidate()
    judge = MockClient(["Rating: [[8]]", "Rating: [[8]]"])
    runner = MTBenchRunner(
        judge=judge,
        judge_model="judge",
        questions=list(SMOKE_QUESTIONS[:1]),
        temperature=0.0,
    )

    runner.run(
        client=candidate,
        model="cand",
        endpoint="http://mock",
        output_dir=tmp_path,
        limit=None,
    )

    assert candidate.temperatures == [0.0, 0.0]


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


def test_mt_bench_expanded_count_and_mock_run(tmp_path: Path, capsys) -> None:
    out_dir = tmp_path / "out"
    rc = main_entry(
        _MTBenchFactory(),
        output_filename="mt-bench-results.json",
        argv=[
            "--mock",
            "--output",
            str(out_dir),
            "--limit",
            "1",
            "--expand-scenarios",
            "--count-scenarios",
            "--validate-scenarios",
            "--judge-api-key-env",
            "DOES_NOT_EXIST",
        ],
    )
    assert rc == 0
    assert '"base": 1' in capsys.readouterr().out

    rc = main_entry(
        _MTBenchFactory(),
        output_filename="mt-bench-results.json",
        argv=[
            "--mock",
            "--output",
            str(out_dir),
            "--limit",
            "1",
            "--expand-scenarios",
            "--judge-api-key-env",
            "DOES_NOT_EXIST",
        ],
    )
    assert rc == 0
    data = json.loads((out_dir / "mt-bench-results.json").read_text("utf-8"))
    assert data["dataset_version"].endswith("+edge-v1")
    assert data["n"] == 22
    assert data["metrics"]["score"] == 0.8


def _factory_args(**overrides: object) -> argparse.Namespace:
    """Namespace matching what ``_cli.build_parser`` + ``augment_parser`` emit."""

    base: dict[str, object] = {
        "mock": False,
        "model_endpoint": None,
        "provider": "cerebras",
        "judge_endpoint": None,
        "judge_provider": None,
        "judge_model": "gpt-4o",
        "judge_api_key_env": "DOES_NOT_EXIST",
        "max_tokens": DEFAULT_MAX_TOKENS,
        "judge_max_tokens": DEFAULT_JUDGE_MAX_TOKENS,
        "temperature": 0.7,
        "expand_scenarios": False,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


def _clear_endpoint_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ENDPOINT_ENV_CHAIN:
        monkeypatch.delenv(name, raising=False)


def test_mt_bench_judge_honors_base_url_env_over_provider_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_endpoint_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")

    runner, mock_responses = _MTBenchFactory().build(_factory_args())

    assert mock_responses is None
    judge = runner._judge
    assert isinstance(judge, HTTPOpenAICompatibleClient)
    assert judge._endpoint == "https://elizacloud.ai/api/v1"


def test_mt_bench_judge_env_chain_falls_through_to_cerebras_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_endpoint_env(monkeypatch)
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://elizacloud.ai/api/v1")

    runner, _ = _MTBenchFactory().build(_factory_args())

    assert runner._judge._endpoint == "https://elizacloud.ai/api/v1"


def test_mt_bench_explicit_judge_endpoint_beats_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_endpoint_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")

    runner, _ = _MTBenchFactory().build(
        _factory_args(judge_endpoint="http://localhost:9999/v1")
    )

    assert runner._judge._endpoint == "http://localhost:9999/v1"


def test_mt_bench_explicit_model_endpoint_beats_env_for_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ``--extra model_endpoint`` reaches adapters as ``--model-endpoint``; the
    # judge inherits it when no separate --judge-endpoint is supplied.
    _clear_endpoint_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")

    runner, _ = _MTBenchFactory().build(
        _factory_args(model_endpoint="http://localhost:8001/v1")
    )

    assert runner._judge._endpoint == "http://localhost:8001/v1"


def test_mt_bench_judge_falls_back_to_provider_default_without_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_endpoint_env(monkeypatch)

    runner, _ = _MTBenchFactory().build(_factory_args())

    assert runner._judge._endpoint == "https://api.cerebras.ai/v1"


def test_mt_bench_unknown_judge_provider_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A bogus --judge-provider must not silently reuse the candidate endpoint.
    _clear_endpoint_env(monkeypatch)

    with pytest.raises(ValueError):
        _MTBenchFactory().build(_factory_args(judge_provider="not-a-real-provider"))
