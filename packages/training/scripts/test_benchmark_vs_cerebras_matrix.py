"""Tests for the benchmark_vs_cerebras matrix artifact and tier variants.

Deterministic and offline: the sample run-result dicts stand in for a real
benchmark sweep, and the two tier tests monkeypatch checkpoint discovery and
the native tool bench so no model is loaded.
"""

from __future__ import annotations

import json
from pathlib import Path

import benchmark_vs_cerebras as bench


class _RegistryEntry:
    eliza_short_name = "eliza-1-2b"
    hf_id = "google/gemma-4-E2B-Base"


def _sample_results() -> list[dict]:
    return [
        {
            "tier": "gemma4-e2b",
            "eliza_short_name": "eliza-1-2b",
            "checkpoint": "/models/eliza-1-2b/final",
            "benchmarks": {
                "hermes": {
                    "tool_call_accuracy": 0.42,
                    "raw_summary": {"buckets": {}},
                }
            },
            "cerebras": {
                "model": "gpt-oss-120b",
                "response_quality_proxy": 0.88,
                "avg_latency_ms": 100,
            },
            "error": None,
        }
    ]


def _sample_base_and_trained_results() -> list[dict]:
    return [
        {
            "tier": "gemma4-e2b",
            "eliza_short_name": "eliza-1-2b",
            "base_model_id": "google/gemma-4-E2B-Base",
            "checkpoint": "/models/eliza-1-2b/final",
            "benchmarks": {
                "hermes": {
                    "tool_call_accuracy": 0.52,
                    "raw_summary": {"buckets": {}},
                }
            },
            "variant_results": [
                {
                    "variant": "base",
                    "model_id": "google/gemma-4-E2B-Base",
                    "model_path": "google/gemma-4-E2B-Base",
                    "tier": "2b",
                    "benchmarks": {
                        "hermes": {
                            "tool_call_accuracy": 0.41,
                            "raw_summary": {"buckets": {}},
                        }
                    },
                },
                {
                    "variant": "trained",
                    "model_id": "eliza-1-2b",
                    "model_path": "/models/eliza-1-2b/final",
                    "tier": "2b",
                    "benchmarks": {
                        "hermes": {
                            "tool_call_accuracy": 0.52,
                            "raw_summary": {"buckets": {}},
                        }
                    },
                },
            ],
            "cerebras": {
                "model": "gpt-oss-120b",
                "response_quality_proxy": 0.88,
                "avg_latency_ms": 100,
            },
            "error": None,
        }
    ]


def test_write_matrix_artifact_from_run_results(tmp_path: Path) -> None:
    path = bench.write_matrix_artifact(
        _sample_results(),
        output_dir=tmp_path,
        cerebras_model="gpt-oss-120b",
    )

    artifact = json.loads(path.read_text())
    assert artifact["schema"] == "eliza_benchmark_matrix_artifact"
    assert artifact["counts"]["rows"] == 2
    assert artifact["referenceModelId"] == "cerebras/gpt-oss-120b"
    assert artifact["comparisons"][0]["tier"] == "2b"
    assert artifact["comparisons"][0]["trainedScore"] == 0.42
    assert artifact["comparisons"][0]["referenceScore"] == 0.88


def test_matrix_rows_include_base_and_trained_variants() -> None:
    rows = bench.matrix_rows_from_results(
        _sample_base_and_trained_results(),
        cerebras_model="gpt-oss-120b",
    )

    assert rows[:2] == [
        {
            "modelId": "google/gemma-4-E2B-Base",
            "variant": "base",
            "tier": "2b",
            "benchmark": "hermes",
            "score": 0.41,
            "raw": {"tool_call_accuracy": 0.41, "raw_summary": {"buckets": {}}},
        },
        {
            "modelId": "eliza-1-2b",
            "variant": "trained",
            "tier": "2b",
            "benchmark": "hermes",
            "score": 0.52,
            "raw": {"tool_call_accuracy": 0.52, "raw_summary": {"buckets": {}}},
        },
    ]


def test_matrix_rows_preserve_dry_run_attempts() -> None:
    rows = bench.matrix_rows_from_results(
        [
            {
                "tier": "gemma4-e2b",
                "eliza_short_name": "eliza-1-2b",
                "base_model_id": "google/gemma-4-E2B-Base",
                "checkpoint": None,
                "variant_results": [
                    {
                        "variant": "base",
                        "model_id": "google/gemma-4-E2B-Base",
                        "model_path": "google/gemma-4-E2B-Base",
                        "tier": "2b",
                        "benchmarks": {
                            "eliza_harness_action_selection": {
                                "tool_call_accuracy": None,
                                "raw_summary": {"dry_run": True},
                            }
                        },
                    }
                ],
                "cerebras": {"dry_run": True, "n_prompts": 1},
                "error": "no checkpoint found",
            }
        ],
        cerebras_model="gpt-oss-120b",
    )

    assert rows == [
        {
            "modelId": "google/gemma-4-E2B-Base",
            "variant": "base",
            "tier": "2b",
            "benchmark": "eliza_harness_action_selection",
            "score": 0.0,
            "metrics": {"dryRun": True},
            "raw": {
                "tool_call_accuracy": None,
                "raw_summary": {"dry_run": True},
                "dryRun": True,
            },
        },
        {
            "modelId": "cerebras/gpt-oss-120b",
            "variant": "reference",
            "provider": "cerebras",
            "tier": "2b",
            "benchmark": "eliza_harness_action_selection",
            "score": 0.0,
            "metrics": {"dryRun": True},
            "raw": {"dry_run": True, "n_prompts": 1, "dryRun": True},
        },
    ]


def test_benchmark_tier_dry_run_preserves_trained_variant_without_checkpoint(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[str] = []

    def fake_run_native_tool_bench(model_path, *_args, **kwargs):
        calls.append(str(model_path))
        assert kwargs["dry_run"] is True
        return {"dry_run": True}

    monkeypatch.setattr(bench, "_find_checkpoint", lambda *_args: None)
    monkeypatch.setattr(bench, "_run_native_tool_bench", fake_run_native_tool_bench)
    monkeypatch.setattr(bench, "_load_prompts", lambda *_args: ["prompt"])

    result = bench.benchmark_tier(
        "gemma4-e2b",
        _RegistryEntry(),
        tmp_path / "checkpoints",
        tmp_path / "out",
        ["eliza_harness_action_selection"],
        cerebras_model="gpt-oss-120b",
        max_samples=1,
        dry_run=True,
        cerebras_available=True,
        variants="both",
    )

    assert calls == ["google/gemma-4-E2B-Base", "eliza-1-2b"]
    assert result["error"] == "no checkpoint found"
    assert [row["variant"] for row in result["variant_results"]] == [
        "base",
        "trained",
    ]
    assert result["variant_results"][1]["model_id"] == "eliza-1-2b"
    assert result["variant_results"][1]["model_path"] == "eliza-1-2b"


def test_matrix_artifact_preserves_live_reference_without_local_variant(
    tmp_path: Path,
) -> None:
    path = bench.write_matrix_artifact(
        [
            {
                "tier": "gemma4-e2b",
                "eliza_short_name": "eliza-1-2b",
                "checkpoint": None,
                "requested_benchmarks": ["eliza_harness_action_selection"],
                "variant_results": [],
                "benchmarks": {},
                "cerebras": {
                    "model": "gpt-oss-120b",
                    "response_quality_proxy": 1.0,
                    "avg_latency_ms": 475.7,
                },
                "error": "no checkpoint found",
            }
        ],
        output_dir=tmp_path,
        cerebras_model="gpt-oss-120b",
    )

    artifact = json.loads(path.read_text())
    assert artifact["counts"]["rows"] == 1
    assert artifact["counts"]["comparisons"] == 1
    assert artifact["comparisons"][0]["tier"] == "2b"
    assert artifact["comparisons"][0]["baseScore"] is None
    assert artifact["comparisons"][0]["trainedScore"] is None
    assert artifact["comparisons"][0]["referenceScore"] == 1.0


def test_benchmark_tier_uses_explicit_trained_model_path(tmp_path: Path, monkeypatch) -> None:
    calls: list[str] = []

    def fake_run_native_tool_bench(model_path, *_args, **_kwargs):
        calls.append(str(model_path))
        return {"buckets": {"tools": {"n": 1, "structure_ok": 1}}}

    monkeypatch.setattr(bench, "_find_checkpoint", lambda *_args: None)
    monkeypatch.setattr(bench, "_run_native_tool_bench", fake_run_native_tool_bench)

    result = bench.benchmark_tier(
        "gemma4-e2b",
        _RegistryEntry(),
        tmp_path / "checkpoints",
        tmp_path / "out",
        ["hermes"],
        cerebras_model="gpt-oss-120b",
        max_samples=1,
        dry_run=False,
        cerebras_available=False,
        variants="trained",
        trained_model_path=tmp_path / "explicit-final",
    )

    assert calls == [str(tmp_path / "explicit-final")]
    assert result["checkpoint"] == str(tmp_path / "explicit-final")
    assert result["variant_results"][0]["model_path"] == str(tmp_path / "explicit-final")
