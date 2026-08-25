"""Tests for build_eliza1_benchmark_matrix.py."""

from __future__ import annotations

import json
from pathlib import Path

import build_eliza1_benchmark_matrix as matrix
from lib.results_store import ResultsStore


def test_build_artifact_computes_improvement_and_reference_delta() -> None:
    artifact = matrix.build_artifact(
        generated_at="2026-05-23T12:00:00+00:00",
        rows=[
            {
                "modelId": "cerebras/gpt-oss-120b",
                "variant": "reference",
                "benchmark": "eliza_harness_action_reason",
                "score": 0.8,
            },
            {
                "modelId": "eliza-1-0b-base",
                "variant": "base",
                "tier": "0b",
                "benchmark": "eliza_harness_action_reason",
                "score": 0.4,
            },
            {
                "modelId": "eliza-1-0b-trained",
                "variant": "trained",
                "tier": "0b",
                "benchmark": "eliza_harness_action_reason",
                "score": 0.5,
            },
        ],
    )

    assert artifact["schema"] == matrix.BENCHMARK_MATRIX_ARTIFACT_SCHEMA
    assert artifact["counts"] == {
        "rows": 3,
        "comparisons": 1,
        "tiers": 1,
        "benchmarks": 1,
    }
    assert artifact["comparisons"][0] == {
        "tier": "0b",
        "benchmark": "eliza_harness_action_reason",
        "baseModelId": "eliza-1-0b-base",
        "trainedModelId": "eliza-1-0b-trained",
        "referenceModelId": "cerebras/gpt-oss-120b",
        "baseScore": 0.4,
        "trainedScore": 0.5,
        "referenceScore": 0.8,
        "improvementAbsolute": 0.1,
        "improvementPercent": 25.0,
        "trainedVsReferenceAbsolute": -0.3,
        "trainedVsReferencePercent": -37.5,
        "dryRun": False,
    }


def test_build_artifact_marks_dry_run_comparisons() -> None:
    artifact = matrix.build_artifact(
        generated_at="2026-05-23T12:00:00+00:00",
        rows=[
            {
                "modelId": "cerebras/gpt-oss-120b",
                "variant": "reference",
                "benchmark": "eliza_harness_action_selection",
                "score": 0.0,
                "metrics": {"dryRun": True},
                "raw": {"dry_run": True},
            },
            {
                "modelId": "google/gemma-4-E2B-Base",
                "variant": "base",
                "tier": "2b",
                "benchmark": "eliza_harness_action_selection",
                "score": 0.0,
                "metrics": {"dryRun": True},
                "raw": {"dry_run": True},
            },
        ],
    )

    assert artifact["counts"] == {
        "rows": 2,
        "comparisons": 1,
        "tiers": 1,
        "benchmarks": 1,
    }
    assert artifact["comparisons"][0]["dryRun"] is True
    assert artifact["comparisons"][0]["trainedScore"] is None


def test_collect_latest_rows_from_results_store(tmp_path: Path) -> None:
    db_path = tmp_path / "results.db"
    store = ResultsStore(db_path=db_path)
    try:
        store.record_run(
            model_id="cerebras/gpt-oss-120b",
            benchmark="eliza_harness_action_reason",
            score=0.8,
            dataset_version="v1",
            code_commit="abc",
            raw_json={"metrics": {"pass_rate": 0.8}},
            ts=1_000,
        )
        store.record_run(
            model_id="eliza-1-0b-base",
            benchmark="eliza_harness_action_reason",
            score=0.4,
            dataset_version="v1",
            code_commit="abc",
            raw_json={"metrics": {"pass_rate": 0.4}},
            ts=1_000,
        )
        store.record_run(
            model_id="eliza-1-0b-trained",
            benchmark="eliza_harness_action_reason",
            score=0.5,
            dataset_version="v2",
            code_commit="def",
            raw_json={"metrics": {"pass_rate": 0.5}},
            ts=2_000,
        )
    finally:
        store.close()

    rows = matrix.collect_latest_rows(
        db_path=db_path,
        specs=[
            matrix.ModelSpec(
                model_id="cerebras/gpt-oss-120b",
                variant="reference",
                provider="cerebras",
            ),
            matrix.ModelSpec(
                model_id="eliza-1-0b-base",
                variant="base",
                tier="0b",
            ),
            matrix.ModelSpec(
                model_id="eliza-1-0b-trained",
                variant="trained",
                tier="0b",
            ),
        ],
    )

    assert len(rows) == 3
    trained = next(row for row in rows if row["variant"] == "trained")
    assert trained["modelId"] == "eliza-1-0b-trained"
    assert trained["datasetVersion"] == "v2"
    assert trained["metrics"] == {"pass_rate": 0.5}


def test_main_writes_matrix_artifact(tmp_path: Path) -> None:
    db_path = tmp_path / "results.db"
    output_dir = tmp_path / "out"
    store = ResultsStore(db_path=db_path)
    try:
        for model_id, score in [
            ("cerebras/gpt-oss-120b", 0.8),
            ("eliza-1-0b-base", 0.4),
            ("eliza-1-0b-trained", 0.5),
        ]:
            store.record_run(
                model_id=model_id,
                benchmark="eliza_harness_action_reason",
                score=score,
                dataset_version="v1",
                code_commit="abc",
                raw_json={},
                ts=1_000,
            )
    finally:
        store.close()

    rc = matrix.main(
        [
            "--results-db",
            str(db_path),
            "--model-spec",
            "reference:cerebras/gpt-oss-120b",
            "--model-spec",
            "base:0b:eliza-1-0b-base",
            "--model-spec",
            "trained:0b:eliza-1-0b-trained",
            "--output-dir",
            str(output_dir),
            "--generated-at",
            "2026-05-23T12:00:00+00:00",
        ]
    )

    assert rc == 0
    artifact = json.loads((output_dir / "benchmark-matrix.json").read_text())
    assert artifact["schema"] == matrix.BENCHMARK_MATRIX_ARTIFACT_SCHEMA
    assert artifact["counts"]["comparisons"] == 1
