"""Tests for build_eliza1_benchmark_matrix.py.

Pure in-memory rows in, artifact dict out — no benchmark run and no I/O
beyond what :func:`build_artifact` itself computes.
"""

from __future__ import annotations

import build_eliza1_benchmark_matrix as matrix


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
