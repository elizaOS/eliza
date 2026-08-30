"""Exercises checkpoint evaluation through its subprocess and artifact boundary."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import eval_checkpoint as evaluator


def test_main_runs_native_benchmark_and_writes_aggregate_result(
    tmp_path: Path, monkeypatch
) -> None:
    checkpoint = tmp_path / "checkpoint-24"
    checkpoint.mkdir()
    validation = tmp_path / "validation.jsonl"
    validation.write_text("{}\n", encoding="utf-8")
    result_path = tmp_path / "result.json"

    def fake_run(command, **_kwargs):
        bench_output = Path(command[command.index("--out-dir") + 1])
        bench_output.mkdir(parents=True)
        (bench_output / "summary.json").write_text(
            json.dumps(
                {
                    "buckets": {
                        "actions": {"n": 3, "structure_ok": 3, "content_ok": 2},
                        "providers": {"n": 1, "structure_ok": 0, "content_ok": 1},
                    },
                    "tokens_per_sec_gen": 17.5,
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evaluator.subprocess, "run", fake_run)
    monkeypatch.setattr(evaluator, "read_peak_vram_mb", lambda: 256)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "eval_checkpoint.py",
            "--checkpoint",
            str(checkpoint),
            "--registry-key",
            "gemma4-e2b",
            "--val-jsonl",
            str(validation),
            "--out",
            str(result_path),
        ],
    )

    assert evaluator.main() == 0
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["step"] == 24
    assert result["structure_ok"] == 0.75
    assert result["content_ok"] == 0.75
    assert result["tokens_per_sec"] == 17.5
    assert result["peak_vram_mb"] == 256
    assert result_path.with_suffix(".bench-summary.json").is_file()


def test_main_refuses_missing_checkpoint_before_running_benchmark(
    tmp_path: Path, monkeypatch
) -> None:
    called = False

    def fake_run(*_args, **_kwargs):
        nonlocal called
        called = True
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evaluator.subprocess, "run", fake_run)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "eval_checkpoint.py",
            "--checkpoint",
            str(tmp_path / "missing"),
            "--registry-key",
            "gemma4-e2b",
            "--out",
            str(tmp_path / "result.json"),
        ],
    )

    with pytest.raises(SystemExit, match="checkpoint dir not found"):
        evaluator.main()
    assert called is False
