"""Tests for `scripts/eval_checkpoint.py` results-store integration.

Exercises only the `record_to_results_store` write path — we don't
spin up the full native tool-call benchmark subprocess here. The training-owned
SQLite results store is exercised against a tmp-path SQLite file.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import eval_checkpoint  # noqa: E402
from lib.results_store import ResultsStore, default_db_path  # noqa: E402


def _fake_result(step: int = 250) -> dict:
    return {
        "step": step,
        "checkpoint_dir": "/tmp/checkpoint-250",
        "structure_ok": 0.82,
        "content_ok": 0.74,
        "tokens_per_sec": 95.0,
        "peak_vram_mb": 18432,
        "evaluated_at": "2026-05-11T00:00:00Z",
        "registry_key": "gemma4-e2b",
    }


def test_record_to_results_store_inserts_row(tmp_path: Path) -> None:
    db_path = tmp_path / "results.db"
    result = _fake_result()

    row_id = eval_checkpoint.record_to_results_store(
        result,
        db_path=db_path,
        dataset_version="eliza-native-v1@2026-05-11",
        code_commit="deadbeef",
    )
    assert row_id > 0

    store = ResultsStore(db_path=db_path)
    try:
        history = store.get_history(
            model_id="gemma4-e2b",
            benchmark=eval_checkpoint.CHECKPOINT_EVAL_BENCHMARK_ID,
            limit=10,
        )
    finally:
        store.close()

    assert len(history) == 1
    run = history[0]
    assert run.benchmark == eval_checkpoint.CHECKPOINT_EVAL_BENCHMARK_ID
    assert run.model_id == "gemma4-e2b"
    assert run.dataset_version == "eliza-native-v1@2026-05-11"
    assert run.code_commit == "deadbeef"
    # Macro-average of 0.82 and 0.74.
    assert abs(run.score - 0.78) < 1e-9
    raw = run.raw()
    assert raw["step"] == 250
    assert raw["structure_ok"] == 0.82
    assert raw["content_ok"] == 0.74
    assert raw["registry_key"] == "gemma4-e2b"


def test_record_to_results_store_emits_distinct_rows_per_step(tmp_path: Path) -> None:
    db_path = tmp_path / "results.db"

    eval_checkpoint.record_to_results_store(
        _fake_result(step=100),
        db_path=db_path,
        dataset_version="v1",
        code_commit="aaa",
    )
    eval_checkpoint.record_to_results_store(
        _fake_result(step=200),
        db_path=db_path,
        dataset_version="v1",
        code_commit="bbb",
    )

    store = ResultsStore(db_path=db_path)
    try:
        history = store.get_history(
            model_id="gemma4-e2b",
            benchmark=eval_checkpoint.CHECKPOINT_EVAL_BENCHMARK_ID,
            limit=10,
        )
    finally:
        store.close()
    steps = sorted(int(run.raw()["step"]) for run in history)
    assert steps == [100, 200]


def test_record_to_results_store_uses_benchmark_id_constant() -> None:
    # The constant is the contract — any change cascades to dashboards
    # that filter rows by benchmark id. Lock it down here.
    assert eval_checkpoint.CHECKPOINT_EVAL_BENCHMARK_ID == "eliza_checkpoint_eval"


def test_record_to_results_store_accepts_main_result_shape(tmp_path: Path) -> None:
    result = _fake_result()
    assert "structure_ok" in result and "format_ok" not in result
    row_id = eval_checkpoint.record_to_results_store(
        result,
        db_path=tmp_path / "main-shape.db",
        dataset_version="v1",
        code_commit="abc",
    )
    assert row_id > 0


def test_default_db_path_preserves_historical_location(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ELIZA_BENCHMARK_RESULTS_DB", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert default_db_path() == tmp_path / ".eliza" / "benchmarks" / "results.db"
