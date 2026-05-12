"""Unit tests for :mod:`benchmarks.lib.results_store`."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from .results_store import (
    BenchmarkRun,
    ComparisonResult,
    ResultsStore,
    default_db_path,
)


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def test_default_db_path_uses_home_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ELIZA_BENCHMARK_RESULTS_DB", raising=False)
    expected = Path.home() / ".eliza" / "benchmarks" / "results.db"
    assert default_db_path() == expected


def test_default_db_path_honors_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    override = tmp_path / "custom.db"
    monkeypatch.setenv("ELIZA_BENCHMARK_RESULTS_DB", str(override))
    assert default_db_path() == override.resolve()


def test_default_db_path_expands_tilde(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELIZA_BENCHMARK_RESULTS_DB", "~/custom.db")
    assert default_db_path() == (Path.home() / "custom.db").resolve()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> ResultsStore:
    db_path = tmp_path / "results.db"
    s = ResultsStore(db_path=db_path)
    try:
        yield s
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Schema creation
# ---------------------------------------------------------------------------


def test_init_creates_parent_dir_and_schema(tmp_path: Path) -> None:
    nested = tmp_path / "nested" / "more" / "results.db"
    s = ResultsStore(db_path=nested)
    # Trigger lazy connect.
    s.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v1",
        code_commit="abc",
        raw_json={"detail": "ok"},
    )

    assert nested.exists()
    with sqlite3.connect(str(nested)) as conn:
        names = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        ]
    s.close()
    assert "benchmark_runs" in names


def test_schema_has_required_columns(store: ResultsStore) -> None:
    # Force connect via a write (history would also work).
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v1",
        code_commit="abc",
        raw_json={"k": 1},
    )
    with sqlite3.connect(str(store.db_path)) as conn:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(benchmark_runs)").fetchall()
        }
    expected = {
        "id",
        "model_id",
        "benchmark",
        "score",
        "ts",
        "dataset_version",
        "code_commit",
        "raw_json",
    }
    assert expected.issubset(cols)


# ---------------------------------------------------------------------------
# Empty-store reads
# ---------------------------------------------------------------------------


def test_get_history_empty_store(store: ResultsStore) -> None:
    assert (
        store.get_history(model_id="eliza-1-2b", benchmark="mmlu", limit=10) == []
    )


def test_get_latest_for_model_empty_store(store: ResultsStore) -> None:
    assert store.get_latest_for_model(model_id="eliza-1-2b") == {}


def test_compare_empty_store(store: ResultsStore) -> None:
    result = store.compare(
        model_a="eliza-1-2b", model_b="qwen-3-9b", benchmark="mmlu"
    )
    assert result == ComparisonResult(
        benchmark="mmlu",
        model_a="eliza-1-2b",
        model_b="qwen-3-9b",
        a_run=None,
        b_run=None,
        delta=None,
    )


# ---------------------------------------------------------------------------
# Roundtrip
# ---------------------------------------------------------------------------


def test_record_and_get_history_returns_newest_first(store: ResultsStore) -> None:
    store.record_run(
        model_id="m",
        benchmark="mmlu",
        score=0.6,
        dataset_version="2024-12",
        code_commit="abc",
        raw_json={"n": 1},
        ts=1_000,
    )
    store.record_run(
        model_id="m",
        benchmark="mmlu",
        score=0.7,
        dataset_version="2024-12",
        code_commit="def",
        raw_json={"n": 2},
        ts=2_000,
    )
    store.record_run(
        model_id="m",
        benchmark="mmlu",
        score=0.65,
        dataset_version="2024-12",
        code_commit="ghi",
        raw_json={"n": 3},
        ts=1_500,
    )

    history = store.get_history(model_id="m", benchmark="mmlu", limit=10)
    assert [r.score for r in history] == [0.7, 0.65, 0.6]
    assert [r.code_commit for r in history] == ["def", "ghi", "abc"]


def test_get_history_limits_results(store: ResultsStore) -> None:
    for i in range(5):
        store.record_run(
            model_id="m",
            benchmark="b",
            score=float(i),
            dataset_version="v1",
            code_commit=f"c{i}",
            raw_json={"i": i},
            ts=1_000 + i,
        )
    history = store.get_history(model_id="m", benchmark="b", limit=2)
    assert len(history) == 2
    assert history[0].score == 4.0
    assert history[1].score == 3.0


def test_get_history_filters_by_model_and_benchmark(store: ResultsStore) -> None:
    store.record_run(
        model_id="m1",
        benchmark="mmlu",
        score=0.5,
        dataset_version="v1",
        code_commit="abc",
        raw_json={},
    )
    store.record_run(
        model_id="m2",
        benchmark="mmlu",
        score=0.6,
        dataset_version="v1",
        code_commit="abc",
        raw_json={},
    )
    store.record_run(
        model_id="m1",
        benchmark="humaneval",
        score=0.7,
        dataset_version="v1",
        code_commit="abc",
        raw_json={},
    )

    history = store.get_history(model_id="m1", benchmark="mmlu", limit=10)
    assert len(history) == 1
    assert history[0].model_id == "m1"
    assert history[0].benchmark == "mmlu"
    assert history[0].score == 0.5


def test_get_history_rejects_invalid_limit(store: ResultsStore) -> None:
    with pytest.raises(ValueError):
        store.get_history(model_id="m", benchmark="b", limit=0)
    with pytest.raises(ValueError):
        store.get_history(model_id="m", benchmark="b", limit=-1)


# ---------------------------------------------------------------------------
# get_latest_for_model
# ---------------------------------------------------------------------------


def test_get_latest_for_model_picks_newest_per_benchmark(store: ResultsStore) -> None:
    store.record_run(
        model_id="m",
        benchmark="mmlu",
        score=0.5,
        dataset_version="v1",
        code_commit="abc",
        raw_json={},
        ts=1_000,
    )
    store.record_run(
        model_id="m",
        benchmark="mmlu",
        score=0.7,
        dataset_version="v1",
        code_commit="def",
        raw_json={},
        ts=3_000,
    )
    store.record_run(
        model_id="m",
        benchmark="humaneval",
        score=0.4,
        dataset_version="v1",
        code_commit="abc",
        raw_json={},
        ts=2_000,
    )

    latest = store.get_latest_for_model(model_id="m")
    assert set(latest.keys()) == {"mmlu", "humaneval"}
    assert latest["mmlu"].score == 0.7
    assert latest["mmlu"].code_commit == "def"
    assert latest["humaneval"].score == 0.4


def test_get_latest_breaks_ties_on_insertion_order(store: ResultsStore) -> None:
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="first",
        raw_json={},
        ts=1_000,
    )
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.6,
        dataset_version="v",
        code_commit="second",
        raw_json={},
        ts=1_000,
    )
    latest = store.get_latest_for_model(model_id="m")
    assert latest["b"].code_commit == "second"


def test_get_latest_isolates_models(store: ResultsStore) -> None:
    store.record_run(
        model_id="m1",
        benchmark="b",
        score=0.1,
        dataset_version="v",
        code_commit="c",
        raw_json={},
    )
    store.record_run(
        model_id="m2",
        benchmark="b",
        score=0.9,
        dataset_version="v",
        code_commit="c",
        raw_json={},
    )
    assert store.get_latest_for_model(model_id="m1")["b"].score == 0.1
    assert store.get_latest_for_model(model_id="m2")["b"].score == 0.9
    assert store.get_latest_for_model(model_id="nope") == {}


# ---------------------------------------------------------------------------
# compare()
# ---------------------------------------------------------------------------


def test_compare_returns_positive_delta_when_a_wins(store: ResultsStore) -> None:
    store.record_run(
        model_id="a",
        benchmark="mmlu",
        score=0.75,
        dataset_version="v",
        code_commit="c",
        raw_json={},
        ts=1_000,
    )
    store.record_run(
        model_id="b",
        benchmark="mmlu",
        score=0.60,
        dataset_version="v",
        code_commit="c",
        raw_json={},
        ts=1_000,
    )
    cmp_ = store.compare(model_a="a", model_b="b", benchmark="mmlu")
    assert cmp_.a_run is not None
    assert cmp_.b_run is not None
    assert cmp_.delta == pytest.approx(0.15)


def test_compare_returns_none_delta_when_one_side_missing(store: ResultsStore) -> None:
    store.record_run(
        model_id="a",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json={},
    )
    cmp_ = store.compare(model_a="a", model_b="missing", benchmark="b")
    assert cmp_.a_run is not None
    assert cmp_.b_run is None
    assert cmp_.delta is None

    cmp_2 = store.compare(model_a="missing", model_b="a", benchmark="b")
    assert cmp_2.a_run is None
    assert cmp_2.b_run is not None
    assert cmp_2.delta is None


def test_compare_uses_most_recent_score(store: ResultsStore) -> None:
    store.record_run(
        model_id="a",
        benchmark="mmlu",
        score=0.5,
        dataset_version="v",
        code_commit="c1",
        raw_json={},
        ts=1_000,
    )
    store.record_run(
        model_id="a",
        benchmark="mmlu",
        score=0.8,
        dataset_version="v",
        code_commit="c2",
        raw_json={},
        ts=2_000,
    )
    store.record_run(
        model_id="b",
        benchmark="mmlu",
        score=0.4,
        dataset_version="v",
        code_commit="c1",
        raw_json={},
        ts=1_500,
    )
    cmp_ = store.compare(model_a="a", model_b="b", benchmark="mmlu")
    assert cmp_.a_run is not None and cmp_.a_run.score == 0.8
    assert cmp_.b_run is not None and cmp_.b_run.score == 0.4
    assert cmp_.delta == pytest.approx(0.4)


# ---------------------------------------------------------------------------
# raw_json handling
# ---------------------------------------------------------------------------


def test_record_run_accepts_string_raw_json(store: ResultsStore) -> None:
    raw = '{"metric":0.5,"name":"x"}'
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json=raw,
    )
    [run] = store.get_history(model_id="m", benchmark="b", limit=10)
    assert run.raw_json == raw
    assert run.raw() == {"metric": 0.5, "name": "x"}


def test_record_run_serializes_mapping_with_sorted_keys(store: ResultsStore) -> None:
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json={"z": 1, "a": 2, "m": 3},
    )
    [run] = store.get_history(model_id="m", benchmark="b", limit=10)
    # Keys serialized alphabetically.
    assert run.raw_json == '{"a":2,"m":3,"z":1}'


def test_record_run_rejects_malformed_string_raw_json(store: ResultsStore) -> None:
    with pytest.raises(json.JSONDecodeError):
        store.record_run(
            model_id="m",
            benchmark="b",
            score=0.5,
            dataset_version="v",
            code_commit="c",
            raw_json="not-json",
        )


def test_run_raw_rejects_non_object_payload(tmp_path: Path) -> None:
    # Bypass record_run's validation to simulate a corrupted row.
    db = tmp_path / "results.db"
    s = ResultsStore(db_path=db)
    s.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json="[1, 2, 3]",
    )
    [run] = s.get_history(model_id="m", benchmark="b", limit=1)
    s.close()
    with pytest.raises(ValueError):
        run.raw()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"model_id": "", "benchmark": "b", "dataset_version": "v", "code_commit": "c"},
        {"model_id": "m", "benchmark": "", "dataset_version": "v", "code_commit": "c"},
        {"model_id": "m", "benchmark": "b", "dataset_version": "", "code_commit": "c"},
        {"model_id": "m", "benchmark": "b", "dataset_version": "v", "code_commit": ""},
    ],
)
def test_record_run_rejects_empty_required_fields(
    store: ResultsStore, kwargs: dict[str, str]
) -> None:
    with pytest.raises(ValueError):
        store.record_run(score=0.5, raw_json={}, **kwargs)


# ---------------------------------------------------------------------------
# ts handling
# ---------------------------------------------------------------------------


def test_record_run_defaults_to_now(store: ResultsStore, monkeypatch: pytest.MonkeyPatch) -> None:
    from . import results_store as module

    monkeypatch.setattr(module.time, "time", lambda: 1234.567)
    store.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json={},
    )
    [run] = store.get_history(model_id="m", benchmark="b", limit=1)
    assert run.ts == 1_234_567


# ---------------------------------------------------------------------------
# Context manager + close
# ---------------------------------------------------------------------------


def test_context_manager_closes_connection(tmp_path: Path) -> None:
    db = tmp_path / "results.db"
    with ResultsStore(db_path=db) as s:
        s.record_run(
            model_id="m",
            benchmark="b",
            score=0.5,
            dataset_version="v",
            code_commit="c",
            raw_json={},
        )
        assert s._conn is not None  # pyright: ignore[reportPrivateUsage]
    # After context manager exits, the internal connection should be released.
    assert s._conn is None  # pyright: ignore[reportPrivateUsage]


def test_close_is_idempotent(tmp_path: Path) -> None:
    s = ResultsStore(db_path=tmp_path / "results.db")
    s.close()
    s.close()  # second close must not raise


# ---------------------------------------------------------------------------
# Multiple stores can read the same DB
# ---------------------------------------------------------------------------


def test_multiple_stores_share_db_file(tmp_path: Path) -> None:
    db = tmp_path / "shared.db"
    writer = ResultsStore(db_path=db)
    writer.record_run(
        model_id="m",
        benchmark="b",
        score=0.5,
        dataset_version="v",
        code_commit="c",
        raw_json={"x": 1},
    )
    writer.close()

    reader = ResultsStore(db_path=db)
    [run] = reader.get_history(model_id="m", benchmark="b", limit=10)
    reader.close()
    assert run.raw() == {"x": 1}
