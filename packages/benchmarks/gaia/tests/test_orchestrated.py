"""Tests for GAIA orchestrated runner helpers."""

import argparse
import json
import os
from pathlib import Path

import pytest

from elizaos_gaia import orchestrated
from elizaos_gaia.orchestrated import (
    _capability_report,
    _effective_provider_labels,
    _model_api_base_for_config,
    _model_provider_for_config,
    _parse_required_capabilities,
    _run_provider,
)
from elizaos_gaia.types import (
    GAIABenchmarkResults,
    GAIALevel,
    GAIAMetrics,
    GAIAResult,
)


def test_parse_required_capabilities_accepts_comma_joined_values() -> None:
    required = _parse_required_capabilities(
        [
            "research.web_search,research.web_browse",
            " research.docs_lookup ",
            "research.web_search",
        ]
    )

    assert required == [
        "research.web_search",
        "research.web_browse",
        "research.docs_lookup",
    ]


def test_canonical_harness_labels_have_default_research_capabilities() -> None:
    required = ["research.web_search", "research.web_browse", "research.docs_lookup"]

    assert _capability_report("eliza", required)["satisfied"] is True
    assert _capability_report("hermes", required)["satisfied"] is True
    assert _capability_report("openclaw", required)["satisfied"] is True


def test_legacy_default_providers_collapse_to_inherited_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "hermes")

    providers = _effective_provider_labels(["claude-code", "swe-agent", "codex"])

    assert providers == ["hermes"]


def test_model_provider_default_preserves_delegate_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCHMARK_MODEL_PROVIDER", raising=False)
    monkeypatch.delenv("ELIZA_PROVIDER", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    assert _model_provider_for_config("eliza") == "eliza"
    assert _model_provider_for_config("hermes") == "openai"
    assert _model_provider_for_config("openclaw") == "openai"
    assert _model_api_base_for_config("eliza") is None
    assert _model_api_base_for_config("hermes") == "https://api.cerebras.ai/v1"


def test_model_provider_normalizes_cerebras_override_to_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "cerebras")
    monkeypatch.delenv("ELIZA_PROVIDER", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    assert _model_provider_for_config("hermes") == "openai"
    assert _model_api_base_for_config("hermes") == "https://api.cerebras.ai/v1"


@pytest.mark.asyncio
async def test_run_provider_sets_harness_env_and_telemetry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.delenv("BENCHMARK_MODEL_PROVIDER", raising=False)
    monkeypatch.delenv("ELIZA_PROVIDER", raising=False)

    async def fake_run_quick_test(config, num_questions: int, hf_token: str | None):
        captured["config_provider"] = config.provider
        captured["config_api_base"] = config.api_base
        captured["num_questions"] = num_questions
        captured["harness"] = os.environ["ELIZA_BENCH_HARNESS"]
        captured["benchmark_harness"] = os.environ["BENCHMARK_HARNESS"]
        captured["model_name"] = os.environ["BENCHMARK_MODEL_NAME"]
        captured["benchmark_model_provider"] = os.environ["BENCHMARK_MODEL_PROVIDER"]
        captured["eliza_provider"] = os.environ["ELIZA_PROVIDER"]
        captured["openai_base_url"] = os.environ.get("OPENAI_BASE_URL")
        Path(os.environ["BENCHMARK_TELEMETRY_JSONL"]).write_text(
            json.dumps({"total_tokens": 17}) + "\n",
            encoding="utf-8",
        )
        return _benchmark_results(
            [
                GAIAResult(
                    task_id="gaia-1",
                    level=GAIALevel.LEVEL_1,
                    question="q",
                    predicted_answer="a",
                    expected_answer="a",
                    is_correct=True,
                )
            ],
            total_tokens=0,
        )

    monkeypatch.setattr(orchestrated, "run_quick_test", fake_run_quick_test)

    payload = await _run_provider(_args(tmp_path), "eliza")

    assert captured == {
        "config_provider": "eliza",
        "config_api_base": None,
        "num_questions": 1,
        "harness": "eliza",
        "benchmark_harness": "eliza",
        "model_name": "gpt-oss-120b",
        "benchmark_model_provider": "eliza",
        "eliza_provider": "eliza",
        "openai_base_url": None,
    }
    assert payload["harness"] == "eliza"
    assert payload["validation"] == {"ok": True, "failure": None}
    assert payload["telemetry"]["total_tokens"] == 17
    assert payload["metrics"]["observed_total_tokens"] == 17
    assert payload["metadata"]["model_provider"] == "eliza"
    assert payload["metadata"]["model_api_base"] is None
    assert payload["metadata"]["benchmark_harness"] == "eliza"
    assert payload["metadata"]["harness_backend"] == "eliza_ts_bridge"
    assert payload["trajectory_artifacts"]["canonical_latest"].endswith(
        "gaia_orchestrated-trajectories-latest.jsonl"
    )


@pytest.mark.asyncio
async def test_run_provider_rejects_zero_token_runs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_quick_test(config, num_questions: int, hf_token: str | None):
        Path(os.environ["BENCHMARK_TELEMETRY_JSONL"]).write_text(
            json.dumps({"total_tokens": 0}) + "\n",
            encoding="utf-8",
        )
        return _benchmark_results(
            [
                GAIAResult(
                    task_id="gaia-1",
                    level=GAIALevel.LEVEL_1,
                    question="q",
                    predicted_answer="wrong",
                    expected_answer="a",
                    is_correct=False,
                )
            ],
            total_tokens=0,
        )

    monkeypatch.setattr(orchestrated, "run_quick_test", fake_run_quick_test)

    payload = await _run_provider(_args(tmp_path), "eliza")

    assert payload["validation"] == {"ok": False, "failure": "zero_tokens"}
    assert "zero_tokens" in str(payload["error"])


@pytest.mark.asyncio
async def test_run_provider_rejects_all_timeout_runs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_quick_test(config, num_questions: int, hf_token: str | None):
        Path(os.environ["BENCHMARK_TELEMETRY_JSONL"]).write_text(
            json.dumps({"total_tokens": 42}) + "\n",
            encoding="utf-8",
        )
        return _benchmark_results(
            [
                GAIAResult(
                    task_id="gaia-1",
                    level=GAIALevel.LEVEL_1,
                    question="q",
                    predicted_answer="",
                    expected_answer="a",
                    is_correct=False,
                    error="Timeout",
                )
            ],
            total_tokens=42,
            errors=1,
        )

    monkeypatch.setattr(orchestrated, "run_quick_test", fake_run_quick_test)

    payload = await _run_provider(_args(tmp_path), "eliza")

    assert payload["validation"] == {"ok": False, "failure": "all_timeout"}
    assert "all_timeout" in str(payload["error"])


def _args(output: Path) -> argparse.Namespace:
    return argparse.Namespace(
        output=str(output),
        dataset="sample",
        dataset_path=None,
        max_questions=1,
        model="gpt-oss-120b",
        temperature=0.0,
    )


def _benchmark_results(
    results: list[GAIAResult],
    *,
    total_tokens: int,
    errors: int = 0,
) -> GAIABenchmarkResults:
    correct = sum(1 for result in results if result.is_correct)
    total = len(results)
    return GAIABenchmarkResults(
        metadata={
            "provider": "eliza",
            "model": "gpt-oss-120b",
            "model_identifier": "eliza_gpt-oss-120b",
        },
        results=results,
        metrics=GAIAMetrics(
            overall_accuracy=correct / total if total else 0.0,
            total_questions=total,
            correct_answers=correct,
            incorrect_answers=total - correct - errors,
            errors=errors,
            total_tokens=total_tokens,
        ),
    )
