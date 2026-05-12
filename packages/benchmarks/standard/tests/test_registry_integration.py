"""Verify the standard adapters are wired into the top-level registry."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.bench_cli_types import ModelSpec
from benchmarks.registry import get_benchmark_registry


def _workspace_root() -> Path:
    # tests/<this>/__file__: parents[0]=tests, [1]=standard, [2]=benchmarks,
    # [3]=packages, [4]=eliza/repo root used by the registry.
    return Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("benchmark_id", ["mmlu", "humaneval", "gsm8k", "mt_bench"])
def test_standard_benchmark_registered(benchmark_id: str) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    assert benchmark_id in registry, f"missing {benchmark_id} from registry"
    entry = registry[benchmark_id]
    assert entry.display_name
    assert entry.description


def test_mmlu_command_routes_through_standard_module(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    cmd = registry["mmlu"].build_command(
        tmp_path,
        ModelSpec(provider="openai", model="gpt-4o-mini"),
        {"model_endpoint": "http://localhost:8000/v1"},
    )
    assert "-m" in cmd
    assert "benchmarks.standard.mmlu" in cmd
    assert "--output" in cmd
    assert str(tmp_path) in cmd
    assert "--model-endpoint" in cmd
    assert "http://localhost:8000/v1" in cmd
    assert "--model" in cmd
    assert "gpt-4o-mini" in cmd


def test_humaneval_command_forwards_timeout(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    cmd = registry["humaneval"].build_command(
        tmp_path,
        ModelSpec(provider="openai", model="m"),
        {"model_endpoint": "http://x/v1", "timeout_s": 20.0},
    )
    assert "--timeout-s" in cmd
    assert "20.0" in cmd


def test_mock_extra_emits_mock_flag(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    cmd = registry["gsm8k"].build_command(
        tmp_path,
        ModelSpec(provider="mock"),
        {},
    )
    assert "--mock" in cmd


def test_locate_result_paths(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    assert registry["mmlu"].locate_result(tmp_path).name == "mmlu-results.json"
    assert registry["humaneval"].locate_result(tmp_path).name == "humaneval-results.json"
    assert registry["gsm8k"].locate_result(tmp_path).name == "gsm8k-results.json"
    assert registry["mt_bench"].locate_result(tmp_path).name == "mt-bench-results.json"


def test_extract_score_reads_metrics_block(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    sample = {
        "benchmark": "mmlu",
        "model": "m",
        "endpoint": "x",
        "dataset_version": "v",
        "n": 4,
        "metrics": {"score": 0.7, "accuracy": 0.7, "correct": 3.0, "n": 4.0},
        "raw_json": {},
    }
    extraction = registry["mmlu"].extract_score(sample)
    assert extraction.score == 0.7
    assert extraction.unit == "ratio"
    assert extraction.higher_is_better is True
    assert extraction.metrics["score"] == 0.7
    assert extraction.metrics["accuracy"] == 0.7


def test_mt_bench_command_passes_judge_args(tmp_path: Path) -> None:
    registry = {entry.id: entry for entry in get_benchmark_registry(_workspace_root())}
    cmd = registry["mt_bench"].build_command(
        tmp_path,
        ModelSpec(provider="openai", model="cand"),
        {
            "model_endpoint": "http://cand/v1",
            "judge_endpoint": "https://api.openai.com/v1",
            "judge_model": "gpt-4o",
            "judge_api_key_env": "OPENAI_JUDGE_KEY",
        },
    )
    assert "--judge-endpoint" in cmd
    assert "https://api.openai.com/v1" in cmd
    assert "--judge-model" in cmd
    assert "gpt-4o" in cmd
    assert "--judge-api-key-env" in cmd
    assert "OPENAI_JUDGE_KEY" in cmd
