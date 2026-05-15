"""Tests for GAIA trajectory artifacts."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pytest

from elizaos_gaia import orchestrated
from elizaos_gaia.runner import GAIARunner
from elizaos_gaia.trajectory import write_trajectory_artifacts
from elizaos_gaia.types import (
    GAIABenchmarkResults,
    GAIAConfig,
    GAIALevel,
    GAIAMetrics,
    GAIAResult,
    StepRecord,
)


def test_write_gaia_trajectory_artifacts(tmp_path: Path) -> None:
    results = _benchmark_results()

    paths = write_trajectory_artifacts(results, tmp_path, timestamp="20260101_000000")

    canonical = Path(paths["canonical"])
    native = Path(paths["native"])
    assert canonical.exists()
    assert native.exists()
    assert Path(paths["canonical_latest"]).exists()
    assert Path(paths["native_latest"]).exists()

    record = json.loads(canonical.read_text(encoding="utf-8").splitlines()[0])
    assert record["schema"] == "elizaos.gaia.trajectory.v1"
    assert record["run_kind"] == "gaia"
    assert record["harness"] == "hermes"
    assert record["harness_backend"] == "hermes_adapter_via_eliza_client"
    assert record["steps"][0]["action"] == "search"

    native_payload = json.loads(native.read_text(encoding="utf-8"))
    assert native_payload["schema"] == "elizaos.gaia.native_trajectories.v1"
    assert native_payload["trajectories"][0]["adapter_steps"][0]["action"] == "search"


@pytest.mark.asyncio
async def test_runner_save_results_emits_trajectory_artifacts(tmp_path: Path) -> None:
    runner = object.__new__(GAIARunner)
    runner.config = GAIAConfig(
        output_dir=str(tmp_path),
        dataset_source="sample",
        save_detailed_logs=True,
        save_trajectories=True,
        include_model_in_output=True,
    )

    await runner._save_results(_benchmark_results())

    model_dir = tmp_path / "sample" / "hermes_gpt-oss-120b"
    assert (model_dir / "gaia-trajectories-latest.jsonl").exists()
    assert (model_dir / "gaia-native-trajectories-latest.json").exists()


@pytest.mark.asyncio
async def test_orchestrated_run_provider_emits_orchestrated_trajectories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_quick_test(config, num_questions: int, hf_token: str | None):
        Path(os.environ["BENCHMARK_TELEMETRY_JSONL"]).write_text(
            json.dumps({"total_tokens": 11}) + "\n",
            encoding="utf-8",
        )
        return _benchmark_results(harness=config.harness or "openclaw")

    monkeypatch.setattr(orchestrated, "run_quick_test", fake_run_quick_test)

    payload = await orchestrated._run_provider(
        argparse.Namespace(
            output=str(tmp_path),
            dataset="sample",
            dataset_path=None,
            max_questions=1,
            model="gpt-oss-120b",
            temperature=0.0,
        ),
        "openclaw",
    )

    artifacts = payload["trajectory_artifacts"]
    assert isinstance(artifacts, dict)
    canonical = Path(str(artifacts["canonical_latest"]))
    native = Path(str(artifacts["native_latest"]))
    assert canonical.exists()
    assert native.exists()
    record = json.loads(canonical.read_text(encoding="utf-8").splitlines()[0])
    assert record["run_kind"] == "gaia_orchestrated"
    assert record["harness"] == "openclaw"


def _benchmark_results(*, harness: str = "hermes") -> GAIABenchmarkResults:
    result = GAIAResult(
        task_id="gaia-trajectory-1",
        level=GAIALevel.LEVEL_1,
        question="q",
        predicted_answer="a",
        expected_answer="a",
        is_correct=True,
        steps_taken=[
            StepRecord(
                step_number=1,
                action="search",
                reasoning="looked up source",
                success=True,
            )
        ],
        token_usage=11,
    )
    return GAIABenchmarkResults(
        metadata={
            "provider": "openai",
            "model": "gpt-oss-120b",
            "model_identifier": f"{harness}_gpt-oss-120b",
            "benchmark_harness": harness,
            "harness_backend": f"{harness}_adapter_via_eliza_client",
            "dataset_source": "sample",
        },
        results=[result],
        metrics=GAIAMetrics(
            overall_accuracy=1.0,
            total_questions=1,
            correct_answers=1,
            incorrect_answers=0,
            errors=0,
            total_tokens=11,
        ),
    )
