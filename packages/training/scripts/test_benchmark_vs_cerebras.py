"""Exercises benchmark execution and generated matrix artifacts without a model."""

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
            "benchmarks": {"hermes": {"tool_call_accuracy": 0.42}},
            "cerebras": {
                "model": "gpt-oss-120b",
                "response_quality_proxy": 0.88,
                "avg_latency_ms": 100,
            },
            "error": None,
        }
    ]


def test_write_matrix_artifact_compares_trained_and_reference_results(
    tmp_path: Path,
) -> None:
    path = bench.write_matrix_artifact(
        _sample_results(),
        output_dir=tmp_path,
        cerebras_model="gpt-oss-120b",
    )

    artifact = json.loads(path.read_text())
    comparison = artifact["comparisons"][0]
    assert comparison["trainedScore"] == 0.42
    assert comparison["referenceScore"] == 0.88
    assert comparison["trainedVsReferenceAbsolute"] == -0.46


def test_benchmark_tier_dry_run_attempts_base_and_trained_variants(
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


def test_benchmark_tier_uses_explicit_trained_model_path(
    tmp_path: Path, monkeypatch
) -> None:
    calls: list[str] = []

    def fake_run_native_tool_bench(model_path, *_args, **_kwargs):
        calls.append(str(model_path))
        return {"buckets": {"tools": {"n": 1, "structure_ok": 1}}}

    monkeypatch.setattr(bench, "_find_checkpoint", lambda *_args: None)
    monkeypatch.setattr(bench, "_run_native_tool_bench", fake_run_native_tool_bench)
    explicit = tmp_path / "explicit-final"

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
        trained_model_path=explicit,
    )

    assert calls == [str(explicit)]
    assert result["checkpoint"] == str(explicit)
